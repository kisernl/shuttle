import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Ctx } from "../ctx.js";
import { audit } from "../lib/audit.js";
import {
  configSources,
  KNOWN_ENV_KEYS,
  resolveConfig,
  saveSetupEnv,
} from "../config.js";

function serverIamPolicy(region: string, accountId: string, prefix: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ManageShuttleParameters",
        Effect: "Allow",
        Action: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
          "ssm:GetParameterHistory",
          "ssm:PutParameter",
          "ssm:DeleteParameter",
          "ssm:DeleteParameters",
          "ssm:AddTagsToResource",
          "ssm:ListTagsForResource",
        ],
        Resource: `arn:aws:ssm:${region}:${accountId}:parameter/${prefix}/*`,
      },
      {
        Sid: "DescribeNeedsWildcard",
        Effect: "Allow",
        Action: "ssm:DescribeParameters",
        Resource: "*",
      },
    ],
  };
}

function optionalIamPolicy(accountId: string, prefix: string) {
  return {
    Sid: "CheckGithubSetup",
    Effect: "Allow",
    Action: ["iam:GetRole", "iam:GetOpenIDConnectProvider"],
    Resource: [
      `arn:aws:iam::${accountId}:role/${prefix}-*`,
      `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`,
    ],
  };
}

/** Identity resolution must not be fatal: when the server has no working AWS
 *  credentials this page is exactly where the admin goes to fix that, so we
 *  still return the config and IAM policies (with an {ACCOUNT_ID} placeholder). */
async function resolveIdentity(ctx: Ctx) {
  try {
    const { account, arn } = await ctx.github.callerIdentity();
    return { account, arn, error: null as string | null };
  } catch (e) {
    return {
      account: null,
      arn: null,
      error: (e as { name?: string })?.name ?? String(e),
    };
  }
}

export interface ChecklistItem {
  id: string;
  /** true = verified, false = problem, null = informational / not yet checked */
  ok: boolean | null;
  title: string;
  detail: string;
  hint?: string;
}

/** Onboarding checklist — every requirement for a working deployment, with a
 *  live status where we can verify one cheaply. */
function buildChecklist(
  ctx: Ctx,
  req: FastifyRequest,
  id: Awaited<ReturnType<typeof resolveIdentity>>,
): ChecklistItem[] {
  const c = ctx.config;
  const items: ChecklistItem[] = [];

  items.push({
    id: "session",
    ok: c.SESSION_SECRET.length >= 32,
    title: "Session secret",
    detail: "SESSION_SECRET is set and at least 32 characters.",
    hint: "Generate one with `openssl rand -hex 32` and set it as an env var.",
  });

  items.push({
    id: "github-oauth",
    ok: Boolean(c.GITHUB_CLIENT_ID && c.GITHUB_CLIENT_SECRET),
    title: "GitHub OAuth app",
    detail: "GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set.",
    hint: `Create an OAuth app at github.com/settings/developers and set the callback URL to ${c.PUBLIC_URL}/api/auth/github/callback.`,
  });

  const allowed = c.ALLOWED_GITHUB_USERS
    ? `users: ${c.ALLOWED_GITHUB_USERS}`
    : `org: ${c.ALLOWED_GITHUB_ORG}`;
  items.push({
    id: "allowed-users",
    ok: Boolean(c.ALLOWED_GITHUB_USERS || c.ALLOWED_GITHUB_ORG),
    title: "Allowed sign-ins",
    detail: `Access is restricted to ${allowed}.`,
    hint: "Set ALLOWED_GITHUB_USERS (comma-separated logins) or ALLOWED_GITHUB_ORG so random GitHub users can't sign in.",
  });

  items.push({
    id: "admin-users",
    ok: c.ADMIN_GITHUB_USERS.split(",").some((s) => s.trim()),
    title: "Admin users",
    detail: `Admins: ${c.ADMIN_GITHUB_USERS}.`,
    hint: "Set ADMIN_GITHUB_USERS to your own GitHub login(s) — admins can manage users, keys, and run setup checks.",
  });

  // PUBLIC_URL must match the host browsers actually use, or OAuth callbacks
  // and __Host- cookies break.
  const publicHost = (() => {
    try {
      return new URL(c.PUBLIC_URL).host;
    } catch {
      return null;
    }
  })();
  const reqHost =
    (req.headers["x-forwarded-host"] as string | undefined)
      ?.split(",")[0]
      ?.trim() ?? (req.headers.host as string | undefined);
  const localhost = /^http:\/\/(localhost|127\.0\.0\.1)/.test(c.PUBLIC_URL);
  items.push({
    id: "public-url",
    ok: localhost || (publicHost !== null && publicHost === reqHost),
    title: "PUBLIC_URL",
    detail:
      publicHost === reqHost || localhost
        ? `PUBLIC_URL (${c.PUBLIC_URL}) matches the host you're browsing.`
        : `PUBLIC_URL is ${c.PUBLIC_URL} but you're browsing ${reqHost ?? "an unknown host"}.`,
    hint: "Set PUBLIC_URL to the exact https:// origin users will visit (including any reverse-proxy path prefix). Wrong value = broken OAuth redirect and cookies.",
  });

  items.push({
    id: "aws-credentials",
    ok: id.account !== null,
    title: "AWS credentials",
    detail: id.account
      ? `Resolved identity: ${id.arn}`
      : `No AWS credentials (${id.error ?? "unknown error"}).`,
    hint: "Provide AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY env vars, or attach an IAM role to the host. See the IAM policy below.",
  });

  items.push({
    id: "aws-iam",
    ok: null,
    title: "AWS IAM permissions",
    detail: "Not checked yet — run the permission probes below.",
    hint: "The probes write, read, and delete a throwaway parameter to verify every SSM action Shuttle needs.",
  });

  items.push({
    id: "kms",
    ok: c.KMS_KEY_ID ? null : true,
    title: "KMS key",
    detail: c.KMS_KEY_ID
      ? `Using customer-managed key ${c.KMS_KEY_ID} — verify kms:GenerateDataKey/kms:Decrypt are granted.`
      : "Using the AWS-managed alias/aws/ssm key — no extra setup.",
    hint: c.KMS_KEY_ID
      ? "If PutParameter/GetParameter probes fail with KMS errors, add kms permissions for this key to the server's IAM identity."
      : undefined,
  });

  return items;
}

/** Env vars the setup wizard can collect. `required` = needed for config to
 *  validate; secrets are never returned to the client, only their source. */
const ENV_FIELDS = [
  {
    key: "PUBLIC_URL",
    label: "Public URL",
    required: true,
    secret: false,
    hint: "The https:// origin users will visit — must match your domain exactly. The GitHub OAuth callback and session cookies depend on it.",
  },
  {
    key: "SESSION_SECRET",
    label: "Session secret",
    required: true,
    secret: true,
    hint: "Random 32+ character string — run `openssl rand -hex 32`.",
  },
  {
    key: "GITHUB_CLIENT_ID",
    label: "GitHub OAuth client ID",
    required: true,
    secret: false,
    hint: "From a GitHub OAuth app (github.com/settings/developers). Callback URL: <your PUBLIC_URL>/api/auth/github/callback",
  },
  {
    key: "GITHUB_CLIENT_SECRET",
    label: "GitHub OAuth client secret",
    required: true,
    secret: true,
    hint: "Shown once when you create the OAuth app.",
  },
  {
    key: "ALLOWED_GITHUB_USERS",
    label: "Allowed GitHub users",
    required: false,
    secret: false,
    hint: "Comma-separated GitHub logins allowed to sign in — or set ALLOWED_GITHUB_ORG instead. At least one is required.",
  },
  {
    key: "ALLOWED_GITHUB_ORG",
    label: "Allowed GitHub org",
    required: false,
    secret: false,
    hint: "Alternatively, any member of this org may sign in.",
  },
  {
    key: "ADMIN_GITHUB_USERS",
    label: "Admin GitHub users",
    required: true,
    secret: false,
    hint: "Comma-separated logins that get the admin role — at minimum, your own.",
  },
  {
    key: "AWS_REGION",
    label: "AWS region",
    required: true,
    secret: false,
    hint: "e.g. us-east-1 — where your SSM parameters live.",
  },
  {
    key: "AWS_ACCESS_KEY_ID",
    label: "AWS access key ID",
    required: false,
    secret: false,
    hint: "Only needed when the host has no IAM role (Railway, Render, ComputeSDK, etc.).",
  },
  {
    key: "AWS_SECRET_ACCESS_KEY",
    label: "AWS secret access key",
    required: false,
    secret: true,
    hint: "Pairs with the access key ID.",
  },
  {
    key: "AWS_SESSION_TOKEN",
    label: "AWS session token",
    required: false,
    secret: true,
    hint: "Only for temporary (STS) credentials.",
  },
  {
    key: "SHUTTLE_PREFIX",
    label: "SSM path prefix",
    required: false,
    secret: false,
    hint: "Defaults to \"shuttle\" — secrets live under /<prefix>/{project}/{env}/.",
  },
  {
    key: "KMS_KEY_ID",
    label: "KMS key ID",
    required: false,
    secret: false,
    hint: "Optional customer-managed key for SecureStrings. Leave empty to use alias/aws/ssm.",
  },
  {
    key: "PROTECTED_ENVS",
    label: "Protected environments",
    required: false,
    secret: false,
    hint: "Comma-separated env names requiring write confirmation. Defaults to \"production\".",
  },
  {
    key: "TRUST_PROXY",
    label: "Trust proxy",
    required: false,
    secret: false,
    hint: "Set to \"true\" when running behind a reverse proxy / platform router (recommended for hosted deploys).",
  },
  {
    key: "PORT",
    label: "Port",
    required: false,
    secret: false,
    hint: "Defaults to 3000 — set by the platform on hosted deploys (e.g. 8080).",
  },
  {
    key: "DATA_DIR",
    label: "Data directory",
    required: false,
    secret: false,
    hint: "Where shuttle.db lives. Defaults to /data — must be a persistent volume.",
  },
] as const;

function envFields(ctx: Ctx) {
  const sources = configSources(ctx.db);
  return ENV_FIELDS.map((f) => ({
    ...f,
    source: sources[f.key] ?? "unset",
    set: (sources[f.key] ?? "unset") !== "unset",
  }));
}

function setupPayload(
  ctx: Ctx,
  req: FastifyRequest,
  id: Awaited<ReturnType<typeof resolveIdentity>>,
) {
  const account = id.account ?? "{ACCOUNT_ID}";
  return {
    setupMode: ctx.setupMode,
    ...(ctx.setupMode
      ? {
          issues: ctx.configIssues,
          sources: configSources(ctx.db),
          fields: envFields(ctx),
        }
      : {}),
    checklist: buildChecklist(ctx, req, id),
    identity: {
      account: id.account,
      arn: id.arn,
      error: id.error,
      region: ctx.config.AWS_REGION,
      prefix: ctx.config.SHUTTLE_PREFIX,
      kmsKeyId: ctx.config.KMS_KEY_ID ?? null,
    },
    iamPolicy: serverIamPolicy(
      ctx.config.AWS_REGION,
      account,
      ctx.config.SHUTTLE_PREFIX,
    ),
    optionalIamPolicy: optionalIamPolicy(account, ctx.config.SHUTTLE_PREFIX),
  };
}

export function setupRoutes(app: FastifyInstance, ctx: Ctx) {
  /** Public liveness probe — the SPA uses this to detect install/setup mode
   *  before any auth exists. In normal mode it reveals nothing. */
  app.get("/api/setup/status", async () => ({
    setupMode: ctx.setupMode,
    ...(ctx.setupMode ? { issues: ctx.configIssues } : {}),
  }));

  // In setup mode nobody can sign in (OAuth isn't configured), so the setup
  // endpoints are open — but only until the config validates, at which point
  // this whole branch is rebuilt behind the admin guard.
  const guard = ctx.setupMode ? {} : { preHandler: [ctx.guard.requireRole("admin")] };

  /** Identity + policies without running probes — powers the always-visible
   *  prerequisites on the setup page. */
  app.get("/api/setup/info", guard, async (req) =>
    setupPayload(ctx, req, await resolveIdentity(ctx)),
  );

  app.post("/api/setup/check", guard, async (req) => {
    const id = await resolveIdentity(ctx);
    const checks = await ctx.params.probe();
    audit(ctx.db, {
      action: "setup.check",
      userLogin: req.user?.login ?? "setup",
      ip: req.ip,
      detail: checks.every((c) => c.ok) ? "all passed" : "failures",
    });
    return { checks, ...setupPayload(ctx, req, id) };
  });

  if (!ctx.setupMode) return;

  /** Wizard submit: persist provided env vars to the settings table, report
   *  remaining validation issues, and hot-reload once the config is complete. */
  app.post("/api/setup/config", async (req) => {
    const body = (req.body ?? {}) as { env?: unknown };
    const env = body.env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) {
      return { ok: false, issues: ["body.env must be an object of KEY: value"] };
    }
    const allowed = new Set<string>(KNOWN_ENV_KEYS);
    const updates: Record<string, string> = {};
    const rejected: string[] = [];
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (!allowed.has(key) || typeof value !== "string" || value.length > 4096) {
        rejected.push(key);
        continue;
      }
      updates[key] = value;
    }
    if (rejected.length) {
      return {
        ok: false,
        issues: [`rejected unknown or invalid keys: ${rejected.join(", ")}`],
      };
    }

    saveSetupEnv(ctx.db, updates);
    audit(ctx.db, {
      action: "setup.config",
      userLogin: "setup",
      ip: req.ip,
      detail: `saved: ${Object.keys(updates).sort().join(", ") || "(none)"}`,
    });

    const resolved = resolveConfig(ctx.db);
    const payload = {
      ok: !resolved.setupMode,
      issues: resolved.issues,
      sources: configSources(ctx.db),
    };
    if (!resolved.setupMode) {
      // Respond first, then swap the app out from under the socket — the
      // wizard reloads the page and lands on the normal login screen.
      setTimeout(() => {
        void Promise.resolve(ctx.onConfigured?.()).catch((err) =>
          app.log.error({ err }, "config reload failed"),
        );
      }, 300);
    }
    return payload;
  });
}
