import { build } from "esbuild";

// Bundle everything except the native module — dist/index.js is self-contained
// except for better-sqlite3, which stays external and resolves from node_modules.
const external = ["better-sqlite3", "better-sqlite3/*"];

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "dist/index.js",
  external,
  banner: {
    js: 'import{createRequire}from"module";const require=createRequire(import.meta.url);',
  },
});
