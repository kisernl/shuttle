#!/usr/bin/env node
/**
 * ComputeSDK platform deploy script.
 *
 * The platform clones this repo and runs `./deploy-app.mjs` detached from the
 * repo root. It prefers the prebuilt release tarball (server bundle + web
 * assets + runtime deps, ~3 MB) attached to the latest GitHub release; if that
 * is unavailable it falls back to a full pnpm install + build. Either way it
 * ends by running the Shuttle server in-process on 0.0.0.0:$PORT (8080).
 *
 * Env vars come from the platform's vault secrets; PORT/NODE_ENV/TRUST_PROXY
 * fall back to sane defaults when unset. SHUTTLE_DIST_URL overrides the
 * tarball URL; SHUTTLE_USE_SOURCE=1 forces the source-build path.
 */
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIST_DIR = ".deploy-dist";

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function sh(cmd) {
  execSync(cmd, { stdio: "inherit" });
}

// Derive the GitHub repo from the clone's origin remote for release downloads.
function githubRepo() {
  try {
    const url = execSync("git remote get-url origin", {
      encoding: "utf8",
    }).trim();
    const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function distUrl() {
  if (process.env.SHUTTLE_DIST_URL) return process.env.SHUTTLE_DIST_URL;
  const repo = githubRepo();
  return repo
    ? `https://github.com/${repo}/releases/latest/download/shuttle-dist.tar.gz`
    : null;
}

function tryDist() {
  // The release tarball ships a linux-x64 glibc better-sqlite3 binding.
  if (process.arch !== "x64") return false;
  const url = distUrl();
  if (!url) return false;
  const tmp = mkdtempSync(join(tmpdir(), "shuttle-dist-"));
  const tarball = join(tmp, "shuttle-dist.tar.gz");
  try {
    console.log(`deploy-app: downloading ${url}`);
    run("curl", ["-fsSL", "--retry", "3", url, "-o", tarball]);
    rmSync(DIST_DIR, { recursive: true, force: true });
    sh(`mkdir -p ${DIST_DIR} && tar -xzf ${tarball} -C ${DIST_DIR}`);
    return join(DIST_DIR, "server", "dist", "index.js");
  } catch (err) {
    console.log(
      `deploy-app: dist download failed (${err.message}); falling back to source build`,
    );
    return false;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function sourceBuild() {
  // pnpm: use whatever is on PATH, else corepack, else a global npm install.
  try {
    run("pnpm", ["--version"]);
  } catch {
    try {
      run("corepack", ["enable"]);
    } catch {}
    try {
      run("pnpm", ["--version"]);
    } catch {
      run("npm", ["install", "-g", "pnpm@10.33.0"]);
    }
  }
  run("pnpm", ["install", "--frozen-lockfile"]);
  run("pnpm", ["--filter", "@shuttle/web", "build"]);
  run("pnpm", ["--filter", "@shuttle/server", "build"]);
  return join("server", "dist", "index.js");
}

process.env.PORT ||= "8080";
process.env.NODE_ENV ||= "production";
process.env.TRUST_PROXY ||= "true";

let entry = process.env.SHUTTLE_USE_SOURCE ? null : tryDist();
if (!entry) entry = sourceBuild();

// Importing the bundle runs the server in this process — no child to orphan.
await import(pathToFileURL(join(process.cwd(), entry)).href);
