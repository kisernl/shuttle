import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { SSMClient } from "@aws-sdk/client-ssm";
import { protectedEnvDefaults, resolveConfig } from "./config.js";
import { openDb, pruneAuditLog } from "./db.js";
import { buildApp } from "./app.js";
import { ParameterService } from "./lib/parameterService.js";
import { rescan } from "./lib/rescan.js";

// DATA_DIR can't come from the DB (chicken-and-egg) — env or the default.
const db = openDb(process.env.DATA_DIR || "/data");
pruneAuditLog(db);

// Docker: /app/dist → /app/web/dist; dev or local build: server/{src,dist} → repo/web/dist
const staticDir = ["../web/dist", "../../web/dist"]
  .map((p) => resolve(import.meta.dirname, p))
  .find((p) => existsSync(p));

let app: FastifyInstance;

/** (Re)build and listen with the currently-resolvable config. Called again
 *  in-process when the setup wizard saves a complete configuration. */
async function boot(): Promise<FastifyInstance> {
  const { config, setupMode, issues } = resolveConfig(db);
  const instance = await buildApp({
    config,
    db,
    ...(staticDir ? { staticDir } : {}),
    setupMode,
    configIssues: issues,
    onConfigured: reload,
  });

  if (!setupMode) {
    // Best-effort rescan of the SSM prefix at startup.
    const params = new ParameterService(
      new SSMClient({ region: config.AWS_REGION }),
      config.SHUTTLE_PREFIX,
      config.KMS_KEY_ID,
    );
    rescan(db, params, protectedEnvDefaults(config)).catch((err) => {
      instance.log.warn(
        { err },
        "startup rescan failed (AWS credentials may not be ready)",
      );
    });
  } else {
    instance.log.warn(
      { issues },
      "required env vars missing — serving setup mode until configured",
    );
  }

  await instance.listen({ port: config.PORT, host: "0.0.0.0" });
  return instance;
}

async function reload(): Promise<void> {
  await app?.close();
  app = await boot();
}

app = await boot();
