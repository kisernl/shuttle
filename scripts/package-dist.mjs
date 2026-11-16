#!/usr/bin/env node
/**
 * Package a prebuilt Shuttle deploy tarball: shuttle-dist.tar.gz
 *
 * Expects an already-built repo (`pnpm -r build` run). The server bundle is
 * self-contained except for better-sqlite3, so the tarball only carries:
 *   server/dist/index.js
 *   web/dist/**
 *   node_modules/{better-sqlite3,bindings,prebuild-install}
 *     (bs3 trimmed to lib/ + build/ — deps/ and src/ are compile-only)
 *
 * deploy-app.mjs downloads this on the ComputeSDK box instead of running
 * pnpm install + builds — deploys drop from minutes to seconds.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "shuttle-dist.tar.gz");

function die(msg) {
  console.error(`package-dist: ${msg}`);
  process.exit(1);
}

for (const p of ["server/dist/index.js", "web/dist/index.html"])
  if (!existsSync(join(ROOT, p)))
    die(`${p} missing — run \`pnpm -r build\` first`);

// Resolve real (non-symlink) package dirs through the server's dependency tree.
const req = createRequire(join(ROOT, "server", "package.json"));
function pkgDir(name, from) {
  const resolved = req.resolve(name, { paths: [from] });
  // Core modules ("buffer", "events", …) resolve without a path — skip them.
  if (!resolved.startsWith("/")) return null;
  let dir = dirname(resolved);
  while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
  return dir === ROOT ? null : dir;
}

// Transitive dependency closure of better-sqlite3 (bindings → file-uri-to-path,
// prebuild-install → tar-fs/rc/etc.) — everything the runtime require()s.
function depClosure() {
  const seen = new Map(); // realpath -> { name, dir }
  const queue = [{ name: "better-sqlite3", from: join(ROOT, "server") }];
  while (queue.length) {
    const { name, from } = queue.shift();
    let dir;
    try {
      dir = pkgDir(name, from);
    } catch {
      continue;
    }
    if (!dir || seen.has(dir)) continue;
    seen.set(dir, { name, dir });
    const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    for (const dep of Object.keys(pj.dependencies ?? {}))
      queue.push({ name: dep, from: dir });
  }
  return [...seen.values()];
}

const stage = mkdtempSync(join(tmpdir(), "shuttle-dist-"));
try {
  mkdirSync(join(stage, "server", "dist"), { recursive: true });
  mkdirSync(join(stage, "web"), { recursive: true });
  mkdirSync(join(stage, "node_modules"), { recursive: true });

  cpSync(
    join(ROOT, "server", "dist", "index.js"),
    join(stage, "server", "dist", "index.js"),
  );
  cpSync(join(ROOT, "web", "dist"), join(stage, "web", "dist"), {
    recursive: true,
  });

  for (const { name, dir: src } of depClosure()) {
    const dest = join(stage, "node_modules", name);
    mkdirSync(dest, { recursive: true });
    if (name === "better-sqlite3") {
      // Runtime needs only lib/ + the prebuilt binding; deps/ and src/ are for
      // compiling from source and would add ~10 MB.
      for (const item of [
        "package.json",
        "lib",
        "build",
        "LICENSE",
        "README.md",
      ])
        cpSync(join(src, item), join(dest, item), { recursive: true });
    } else {
      cpSync(src, dest, { recursive: true });
    }
  }

  execFileSync("tar", ["-czf", OUT, "-C", stage, "."], { stdio: "inherit" });
  const size = Number(
    execFileSync("stat", ["-c", "%s", OUT], { encoding: "utf8" }).trim(),
  );
  console.log(`wrote ${OUT} (${(size / 1e6).toFixed(1)} MB)`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
