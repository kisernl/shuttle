import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { configSchema, type Config } from "@shuttle/shared";
import { allSettings, deleteSetting, setSetting } from "./db.js";

/** Settings-table prefix for env vars captured by the setup wizard. */
export const SETUP_ENV_PREFIX = "env.";

/** Every env var the app understands — real config keys plus AWS credential
 *  vars that aren't part of configSchema but are needed for SSM access. */
export const KNOWN_ENV_KEYS = [
  "PUBLIC_URL",
  "SESSION_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "ALLOWED_GITHUB_USERS",
  "ALLOWED_GITHUB_ORG",
  "ADMIN_GITHUB_USERS",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SHUTTLE_PREFIX",
  "KMS_KEY_ID",
  "PROTECTED_ENVS",
  "DATA_DIR",
  "PORT",
  "LOG_LEVEL",
  "TRUST_PROXY",
] as const;

export type EnvSource = "env" | "setup" | "unset";

/** Where each known env var currently comes from (never exposes values). */
export function configSources(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, EnvSource> {
  const stored = allSettings(db);
  const out: Record<string, EnvSource> = {};
  for (const key of KNOWN_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== "") out[key] = "env";
    else if (stored.has(SETUP_ENV_PREFIX + key)) out[key] = "setup";
    else out[key] = "unset";
  }
  return out;
}

/** Env vars saved by the setup wizard, keyed without the prefix. */
export function storedEnv(db: Database.Database): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of allSettings(db)) {
    if (k.startsWith(SETUP_ENV_PREFIX)) out[k.slice(SETUP_ENV_PREFIX.length)] = v;
  }
  return out;
}

/** Persist wizard-provided env vars. Empty string clears a stored value. */
export function saveSetupEnv(
  db: Database.Database,
  updates: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === "") deleteSetting(db, SETUP_ENV_PREFIX + key);
    else setSetting(db, SETUP_ENV_PREFIX + key, value);
  }
}

/** A bootable stand-in config used while required env vars are missing, so the
 *  app can serve the setup wizard instead of exiting. Never used for real
 *  traffic — buildApp gates all non-setup routes on setupMode. */
function placeholderConfig(env: NodeJS.ProcessEnv): Config {
  return {
    PUBLIC_URL: env.PUBLIC_URL || "http://localhost:3000",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    GITHUB_CLIENT_ID: "",
    GITHUB_CLIENT_SECRET: "",
    ALLOWED_GITHUB_USERS: env.ALLOWED_GITHUB_USERS || undefined,
    ALLOWED_GITHUB_ORG: env.ALLOWED_GITHUB_ORG || undefined,
    ADMIN_GITHUB_USERS: "",
    AWS_REGION: env.AWS_REGION || "us-east-1",
    SHUTTLE_PREFIX: env.SHUTTLE_PREFIX || "shuttle",
    KMS_KEY_ID: env.KMS_KEY_ID || undefined,
    PROTECTED_ENVS: env.PROTECTED_ENVS || "production",
    DATA_DIR: env.DATA_DIR || "/data",
    PORT: Number(env.PORT) || 3000,
    LOG_LEVEL: "info",
    TRUST_PROXY: env.TRUST_PROXY === "true" ? "true" : "false",
  } as Config;
}

export interface ResolvedConfig {
  config: Config;
  /** true when required env vars are missing/invalid — serve setup mode only */
  setupMode: boolean;
  /** human-readable validation problems (empty when setupMode is false) */
  issues: string[];
}

/** Merge stored setup env vars under process.env (real env always wins) and
 *  validate. Falls back to a placeholder config in setup mode. */
export function resolveConfig(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedConfig {
  const merged = { ...storedEnv(db), ...env };
  const result = configSchema.safeParse(merged);
  if (result.success) return { config: result.data, setupMode: false, issues: [] };
  return {
    config: placeholderConfig(env),
    setupMode: true,
    issues: result.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    ),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    console.error(`shuttle: invalid configuration\n${problems}`);
    process.exit(1);
  }
  return result.data;
}

export function adminLogins(config: Config): Set<string> {
  return new Set(
    config.ADMIN_GITHUB_USERS.split(",").map((s) => s.trim().toLowerCase()),
  );
}

export function allowedUserLogins(config: Config): Set<string> {
  return new Set(
    (config.ALLOWED_GITHUB_USERS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function protectedEnvDefaults(config: Config): Set<string> {
  return new Set(
    config.PROTECTED_ENVS.split(",").map((s) => s.trim()).filter(Boolean),
  );
}
