#!/usr/bin/env node
/**
 * Deploy Shuttle via the ComputeSDK Platform "deployments" API (beta).
 *
 * Unlike deploy.mjs (which drives a sandbox by hand), this submits a
 * deployment spec and the platform runs the whole sequence server-side:
 * clone/pull the repo, run `setup`, spawn `start` detached, probe the port,
 * and expose a public URL.
 *
 * The spec contract (platform-side `runDeploy`):
 *   repo.url / repo.ref / repo.tokenEnv — git source (omit repo to use `files`)
 *   secrets[]     — org vault secret names injected as env vars on the box
 *   cwd           — directory setup/start run in
 *   files         — inline files written before setup (alternative to repo)
 *   setup         — one-shot POSIX sh command; must exit 0
 *   start         — long-running command; must bind 0.0.0.0:<port>
 *   port          — port the public URL exposes
 *
 * IMPORTANT — env vars: the platform only injects *vault secret names*, so
 * every Shuttle env var (SESSION_SECRET, GITHUB_CLIENT_ID, AWS_*, ...) must
 * exist in the org vault first (platform UI or `compute actions vault`) and
 * be listed with --secret. PUBLIC_URL is special: it must equal the public
 * deployment URL, which only exists after the first deploy — deploy once,
 * set the PUBLIC_URL vault secret to the returned URL, then deploy again.
 *
 * Usage:
 *   COMPUTE_API_KEY=... node deploy-api.mjs --secret SESSION_SECRET \
 *     --secret GITHUB_CLIENT_ID --secret GITHUB_CLIENT_SECRET \
 *     --secret ALLOWED_GITHUB_USERS --secret ADMIN_GITHUB_USERS \
 *     --secret AWS_REGION --secret AWS_ACCESS_KEY_ID --secret AWS_SECRET_ACCESS_KEY
 *
 * Options: --repo URL --ref BRANCH --cwd DIR --port N --token-env VAR
 *          --secret NAME (repeatable) --setup "cmd" --start "cmd"
 *          --dry-run --api-base URL
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");

const API_BASE =
  process.env.COMPUTE_DEPLOY_API_BASE ??
  "https://platform.computesdk.com/api/v1";
// The deployments surface is beta — adjust if the route differs.
const DEPLOY_PATH = process.env.COMPUTE_DEPLOY_PATH ?? "/deployments";

function die(msg) {
  console.error(`deploy-api: ${msg}`);
  process.exit(1);
}

// ---------- args ----------
const opts = {
  repo: null,
  ref: null,
  cwd: "app",
  port: 8080,
  tokenEnv: null,
  secrets: [],
  setup: null,
  start: null,
  dryRun: false,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => {
    const v = argv[++i];
    if (v === undefined) die(`${a} needs a value`);
    return v;
  };
  switch (a) {
    case "--repo":
      opts.repo = next();
      break;
    case "--ref":
      opts.ref = next();
      break;
    case "--cwd":
      opts.cwd = next();
      break;
    case "--port":
      opts.port = Number(next());
      break;
    case "--token-env":
      opts.tokenEnv = next();
      break;
    case "--secret":
      opts.secrets.push(next());
      break;
    case "--setup":
      opts.setup = next();
      break;
    case "--start":
      opts.start = next();
      break;
    case "--dry-run":
      opts.dryRun = true;
      break;
    case "-h":
    case "--help":
      console.log(
        readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0],
      );
      process.exit(0);
    default:
      die(`unknown flag ${a} (try --help)`);
  }
}

// ---------- env ----------
function parseEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    )
      v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
const envFile = [join(ROOT, "deploy", ".env"), join(ROOT, ".env")].find((p) =>
  existsSync(p),
);
const fileEnv = envFile ? parseEnvFile(envFile) : {};
const env = { ...fileEnv, ...process.env };

const apiKey = env.COMPUTE_API_KEY;
if (!apiKey)
  die(
    "COMPUTE_API_KEY is required (org API key from platform.computesdk.com → Settings → API keys)",
  );

// ---------- repo ----------
function defaultRepoUrl() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim();
    // git@github.com:org/repo.git → https://github.com/org/repo.git
    return url.replace(/^git@([^:]+):/, "https://$1/");
  } catch {
    return null;
  }
}
const repoUrl = opts.repo ?? defaultRepoUrl();
if (!repoUrl)
  die(
    "no repo URL — pass --repo or run inside a git checkout with an origin remote",
  );

// ---------- setup / start ----------
// POSIX sh only (the platform runs `setup` via sh — no bashisms).
// setup only guarantees Node 22 — deploy-app.mjs needs it for its shebang and
// then handles everything else (prebuilt dist download or pnpm source build).
const DEFAULT_SETUP = `set -e
export PATH="/opt/node/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || [ "$(node -p "process.versions.node.split('.')[0]")" != "22" ]; then
  arch=$(uname -m)
  case "$arch" in
    x86_64) n=x64 ;;
    aarch64|arm64) n=arm64 ;;
    *) echo "unsupported arch: $arch" >&2; exit 1 ;;
  esac
  base=https://nodejs.org/dist/latest-v22.x
  f=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v n="$n" 'index($2, "linux-" n ".tar.xz") {print $2; exit}')
  [ -n "$f" ] || { echo "no Node 22 tarball for linux-$n" >&2; exit 1; }
  curl -fsSL "$base/$f" -o /tmp/node.tar.xz
  mkdir -p /opt/node
  tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
fi`;

// cwd is the repo root inside the box; deploy-app.mjs downloads the release
// tarball (or falls back to pnpm install + build) and serves :8080 itself.
const DEFAULT_START = `export PATH="/opt/node/bin:$PATH"
export PORT="8080"
exec ./deploy-app.mjs`;

// ---------- spec ----------
const spec = {
  repo: {
    url: repoUrl,
    ...(opts.ref ? { ref: opts.ref } : {}),
    ...(opts.tokenEnv ? { tokenEnv: opts.tokenEnv } : {}),
  },
  ...(opts.secrets.length ? { secrets: opts.secrets } : {}),
  cwd: opts.cwd,
  setup: opts.setup ?? DEFAULT_SETUP,
  start: opts.start ?? DEFAULT_START,
  port: opts.port,
};

if (opts.dryRun) {
  console.log(JSON.stringify(spec, null, 2));
  process.exit(0);
}

// ---------- submit ----------
const res = await fetch(`${API_BASE}${DEPLOY_PATH}`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(spec),
});
const text = await res.text();
let body;
try {
  body = JSON.parse(text);
} catch {
  body = text;
}
if (!res.ok) {
  console.error(`deploy-api: HTTP ${res.status}`);
  console.error(
    typeof body === "string" ? body : JSON.stringify(body, null, 2),
  );
  process.exit(1);
}

const url =
  body?.url ??
  body?.previewUrl ??
  body?.publicUrl ??
  body?.deployment?.url ??
  body?.app?.url ??
  null;

console.log(`deployment accepted`);
if (url) console.log(`URL: ${url}`);
console.log(JSON.stringify(body, null, 2));
if (url) {
  console.log(`
Next step: make sure a vault secret named PUBLIC_URL equals ${url}, then
deploy again so OAuth callbacks and cookies line up.
`);
}
