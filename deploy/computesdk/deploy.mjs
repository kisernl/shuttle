#!/usr/bin/env node
/**
 * Deploy Shuttle to a ComputeSDK hosted sandbox.
 *
 * The ComputeSDK platform router places the sandbox on your org's providers or
 * the compute market — no provider keys needed, only COMPUTE_API_KEY (org API
 * key from https://platform.computesdk.com → Settings → API keys).
 *
 * Usage:
 *   cd deploy/computesdk && pnpm install --ignore-workspace
 *   cp ../../deploy/.env.example .env   # or pass --env-file
 *   COMPUTE_API_KEY=... node deploy.mjs --env-file .env
 *
 *   # reuse an existing sandbox (redeploy code + restart the server):
 *   node deploy.mjs --sandbox <id> --env-file .env
 *
 *   # tear down (stops billing):
 *   node deploy.mjs --destroy <id>
 *
 * Options: --size small|medium|large|xlarge --timeout-hours N --disk <diskId>
 *          --provider-order a,b --order-type market|limit --max-price 0.12/hour
 *          --label NAME --env-file PATH
 *
 * Notes:
 * - Sandboxes expire after `timeout` (default 168h; provider caps may apply).
 *   Extend with snapshot/restore or recreate — see README.md.
 * - Pass --disk <orgSlug>/<name> to mount a persistent org disk at /data so
 *   the SQLite database survives sandbox replacement.
 * - Secrets are passed to the server process only, never baked into images.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compute } from "computesdk";
import { platform } from "@computesdk/platform";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const PORT = 3000;
const APP_DIR = "/app/shuttle";
const BUILD_TIMEOUT_MS = 15 * 60_000;
const HEALTH_TIMEOUT_MS = 120_000;

function die(msg) {
  console.error(`deploy: ${msg}`);
  process.exit(1);
}

function usage() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const header = src.slice(src.indexOf("/**") + 3, src.indexOf("*/"));
  console.log(
    header
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, ""))
      .join("\n"),
  );
}

// ---------- args ----------
const opts = {
  envFile: null,
  size: "medium",
  timeoutHours: 168,
  sandbox: null,
  destroy: null,
  disk: null,
  providerOrder: null,
  orderType: null,
  maxPrice: null,
  label: "shuttle",
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
    case "--env-file":
      opts.envFile = next();
      break;
    case "--size":
      opts.size = next();
      break;
    case "--timeout-hours":
      opts.timeoutHours = Number(next());
      break;
    case "--sandbox":
      opts.sandbox = next();
      break;
    case "--destroy":
      opts.destroy = next();
      break;
    case "--disk":
      opts.disk = next();
      break;
    case "--provider-order":
      opts.providerOrder = next().split(",");
      break;
    case "--order-type":
      opts.orderType = next();
      break;
    case "--max-price": {
      const [usd, per] = next().split("/");
      opts.maxPrice = { usd: Number(usd), per };
      break;
    }
    case "--label":
      opts.label = next();
      break;
    case "-h":
    case "--help":
      usage();
      process.exit(0);
    default:
      die(`unknown flag ${a} (try --help)`);
  }
}
if (!Number.isFinite(opts.timeoutHours) || opts.timeoutHours <= 0)
  die("--timeout-hours must be a positive number");

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

const envFile =
  opts.envFile ??
  [join(ROOT, "deploy", ".env"), join(ROOT, ".env")].find((p) => existsSync(p));
if (opts.envFile && !existsSync(opts.envFile))
  die(`env file not found: ${opts.envFile}`);
const fileEnv = envFile ? parseEnvFile(envFile) : {};
// process.env wins over the file so CI/one-off overrides work.
const env = {
  ...fileEnv,
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined),
  ),
};

const APP_KEYS = [
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
  "AWS_ENDPOINT_URL",
  "SHUTTLE_PREFIX",
  "KMS_KEY_ID",
  "PROTECTED_ENVS",
  "DATA_DIR",
  "LOG_LEVEL",
];

function appEnv(publicUrl) {
  const out = {
    PATH: "/opt/node/bin:/usr/local/bin:/usr/bin:/bin",
    PORT: String(PORT),
    NODE_ENV: "production",
    TRUST_PROXY: "true",
  };
  for (const k of APP_KEYS) if (env[k]) out[k] = env[k];
  if (publicUrl) out.PUBLIC_URL = publicUrl;
  return out;
}

function validateEnv() {
  const problems = [];
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)
    problems.push("SESSION_SECRET (32+ chars)");
  if (!env.GITHUB_CLIENT_ID) problems.push("GITHUB_CLIENT_ID");
  if (!env.GITHUB_CLIENT_SECRET) problems.push("GITHUB_CLIENT_SECRET");
  if (!env.ADMIN_GITHUB_USERS) problems.push("ADMIN_GITHUB_USERS");
  if (!env.AWS_REGION) problems.push("AWS_REGION");
  if (!env.ALLOWED_GITHUB_USERS && !env.ALLOWED_GITHUB_ORG)
    problems.push("ALLOWED_GITHUB_USERS or ALLOWED_GITHUB_ORG");
  if (problems.length)
    die(
      `missing/invalid env: ${problems.join(", ")} (see deploy/.env.example)`,
    );
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY)
    console.warn(
      "deploy: warning — no AWS_ACCESS_KEY_ID/SECRET; the app will start but every SSM call will fail",
    );
}

// ---------- source tarball ----------
function packSource() {
  const dir = mkdtempSync(join(tmpdir(), "shuttle-src-"));
  const out = join(dir, "src.tgz");
  try {
    // Preferred: everything git would track plus untracked non-ignored files.
    const files = execFileSync(
      "git",
      ["ls-files", "-co", "--exclude-standard", "-z"],
      { cwd: ROOT, encoding: "buffer" },
    )
      .toString()
      .split("\0")
      .filter(Boolean);
    if (!files.length) throw new Error("empty file list");
    const list = join(dir, "files.txt");
    // Newline-separated; -T treats each line as a name (newline-in-filename is
    // not supported, which is fine for this repo).
    writeFileSync(list, files.join("\n") + "\n");
    execFileSync("tar", ["-czf", out, "-C", ROOT, "-T", list], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    // Fallback for non-git copies: tar the tree minus ignores/build output.
    execFileSync(
      "tar",
      [
        "-czf",
        out,
        "--exclude=.git",
        "--exclude=*node_modules*",
        "--exclude=*dist*",
        "--exclude=.data",
        "--exclude=.env*",
        "--exclude=*test-results*",
        "--exclude=*playwright-report*",
        "--exclude=*coverage*",
        "-C",
        ROOT,
        ".",
      ],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  const size = statSync(out).size;
  // The files API carries ~4 MB/request; base64 inflates ~33%.
  if (size > 2_800_000)
    die(
      `source tarball is ${(size / 1e6).toFixed(1)} MB — too large for the files API`,
    );
  return out;
}

// ---------- sandbox helpers ----------
async function sh(inst, cmd, { timeout } = {}) {
  const r = await inst.runCommand(cmd, {
    timeout,
    onStdout: (d) => process.stdout.write(d),
    onStderr: (d) => process.stderr.write(d),
  });
  if (r.exitCode !== 0) die(`command failed (exit ${r.exitCode}): ${cmd}`);
  return r;
}

async function startServer(inst, serverEnv) {
  return inst.startProcess(`cd ${APP_DIR} && exec node server/dist/index.js`, {
    cwd: APP_DIR,
    env: serverEnv,
    onStdout: (d) => process.stdout.write(d),
    onStderr: (d) => process.stderr.write(d),
  });
}

async function waitHealthy(url, ms = HEALTH_TIMEOUT_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${url}/api/healthz`, {
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  die(`server did not become healthy at ${url}`);
}

// ---------- main ----------
if (opts.destroy) {
  compute.setConfig({ provider: platform({ apiKey: env.COMPUTE_API_KEY }) });
  const inst = await compute.instances.getById(opts.destroy);
  if (!inst) die(`sandbox ${opts.destroy} not found`);
  await inst.destroy();
  console.log(`destroyed ${opts.destroy} — billing stopped`);
  process.exit(0);
}

if (!env.COMPUTE_API_KEY)
  die(
    "COMPUTE_API_KEY is required (org API key from platform.computesdk.com → Settings → API keys)",
  );
validateEnv();

compute.setConfig({
  provider: platform({
    apiKey: env.COMPUTE_API_KEY,
    ...(env.COMPUTE_ORG ? { org: env.COMPUTE_ORG } : {}),
    ...(env.COMPUTE_PLATFORM_URL ? { baseUrl: env.COMPUTE_PLATFORM_URL } : {}),
  }),
});

// Create or reattach.
let inst;
if (opts.sandbox) {
  console.log(`reusing sandbox ${opts.sandbox} …`);
  inst = await compute.instances.getById(opts.sandbox);
  if (!inst) die(`sandbox ${opts.sandbox} not found (destroyed or expired?)`);
} else {
  const createOpts = {
    size: opts.size,
    timeout: opts.timeoutHours * 3_600_000,
    ephemeral: false,
    label: opts.label,
  };
  if (opts.disk) createOpts.disk = { diskId: opts.disk, path: "/data" };
  if (opts.providerOrder) createOpts.providerOrder = opts.providerOrder;
  if (opts.orderType) createOpts.orderType = opts.orderType;
  if (opts.maxPrice) createOpts.maxPrice = opts.maxPrice;
  console.log(
    `creating sandbox (${opts.size}, ${opts.timeoutHours}h timeout) …`,
  );
  inst = await compute.instances.create(createOpts);
  console.log(`sandbox ${inst.instanceId} on ${inst.provider}`);
}

// Upload source.
const tarball = packSource();
console.log(
  `uploading source (${(statSync(tarball).size / 1e3).toFixed(0)} KB) …`,
);
await inst.filesystem.writeFile(
  "/tmp/shuttle-src.tgz.b64",
  readFileSync(tarball).toString("base64"),
);
await sh(
  inst,
  `mkdir -p ${APP_DIR} && base64 -d /tmp/shuttle-src.tgz.b64 | tar -xz -C ${APP_DIR} && rm -f /tmp/shuttle-src.tgz.b64`,
);

// Ensure Node 22 + pnpm (no-ops when the image already has them).
await sh(
  inst,
  `if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" = "22" ]; then exit 0; fi
arch=$(uname -m)
case "$arch" in x86_64) n=x64 ;; aarch64|arm64) n=arm64 ;; *) echo "unsupported arch: $arch" >&2; exit 1 ;; esac
base=https://nodejs.org/dist/latest-v22.x
f=$(curl -fsSL "$base/SHASUMS256.txt" | awk -v n="$n" 'index($2, "linux-" n ".tar.xz") {print $2; exit}')
[ -n "$f" ] || { echo "no Node 22 tarball for linux-$n" >&2; exit 1; }
curl -fsSL "$base/$f" -o /tmp/node.tar.xz
mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node 2>/dev/null || true
ln -sf /opt/node/bin/npm /usr/local/bin/npm 2>/dev/null || true
ln -sf /opt/node/bin/npx /usr/local/bin/npx 2>/dev/null || true
/opt/node/bin/node -v`,
);
await sh(
  inst,
  `export PATH=/opt/node/bin:$PATH
command -v pnpm >/dev/null 2>&1 || npm install -g pnpm@10.33.0
pnpm --version`,
);

// Install + build (long — runs as a tracked process).
console.log("installing dependencies and building …");
const build = await inst.startProcess(
  `cd ${APP_DIR} && pnpm install --frozen-lockfile && pnpm --filter @shuttle/web build && pnpm --filter @shuttle/server build`,
  {
    env: { PATH: "/opt/node/bin:/usr/local/bin:/usr/bin:/bin" },
    onStdout: (d) => process.stdout.write(d),
    onStderr: (d) => process.stderr.write(d),
  },
);
let buildResult;
try {
  buildResult = await build.wait({ timeout: BUILD_TIMEOUT_MS });
} catch {
  die(`build timed out after ${BUILD_TIMEOUT_MS / 60_000} minutes`);
}
if (buildResult.exitCode !== 0) die("build failed");

// On reuse, stop any previous server before starting the new one.
if (opts.sandbox)
  await sh(inst, `pkill -f 'node server/dist/index.js' 2>/dev/null; true`);

// Resolve the public URL. getUrl usually works before the port listens; if the
// provider requires a listener, boot once with a placeholder PUBLIC_URL, grab
// the URL, then restart with the real one.
let publicUrl = null;
try {
  publicUrl = await inst.getUrl({ port: PORT, protocol: "https" });
} catch {}

let proc;
if (publicUrl) {
  proc = await startServer(inst, appEnv(publicUrl));
} else {
  console.log("preview URL not ready — booting once to resolve it …");
  proc = await startServer(inst, appEnv("http://localhost:3000"));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const r = await inst.runCommand(
      `curl -fsS -o /dev/null http://localhost:${PORT}/api/healthz`,
    );
    if (r.exitCode === 0) break;
    if (Date.now() > deadline) die("server did not start");
    await new Promise((r) => setTimeout(r, 2000));
  }
  publicUrl = await inst.getUrl({ port: PORT, protocol: "https" });
  await proc.kill();
  proc = await startServer(inst, appEnv(publicUrl));
}

console.log("waiting for health check …");
await waitHealthy(publicUrl);

console.log(`
Shuttle is live
  URL:       ${publicUrl}
  Sandbox:   ${inst.instanceId} (${inst.provider})
  Size:      ${opts.size} · expires in ~${opts.timeoutHours}h

Manage it:
  Redeploy:  node deploy.mjs --sandbox ${inst.instanceId} --env-file ${envFile ?? "<your env file>"}
  Destroy:   node deploy.mjs --destroy ${inst.instanceId}   (stops billing)
  Snapshot:  compute sandboxes snapshot ${inst.instanceId}  (CLI; enables restore later)
`);
