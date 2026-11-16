#!/usr/bin/env node
/**
 * ComputeSDK platform deploy script.
 *
 * The platform clones this repo and runs `./deploy-app.mjs` detached from the
 * repo root. This script installs dependencies, builds the SPA and server,
 * then execs the Shuttle server in-process on 0.0.0.0:$PORT (default 8080).
 *
 * Env vars come from the platform's vault secrets; PORT/NODE_ENV/TRUST_PROXY
 * fall back to sane defaults when unset.
 */
import { execFileSync } from "node:child_process";

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: "inherit" });
}

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

process.env.PORT ||= "8080";
process.env.NODE_ENV ||= "production";
process.env.TRUST_PROXY ||= "true";

// Importing the bundle runs the server in this process — no child to orphan.
await import("./server/dist/index.js");
