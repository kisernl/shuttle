import type Database from "better-sqlite3";
import type { Config } from "@shuttle/shared";
import type { makeGuard } from "./guard.js";
import type { GithubSetupService } from "./lib/githubSetupService.js";
import type { ParameterService } from "./lib/parameterService.js";

export interface Ctx {
  db: Database.Database;
  config: Config;
  params: ParameterService;
  github: GithubSetupService;
  guard: ReturnType<typeof makeGuard>;
  /** True while required env vars are missing — only setup routes are live. */
  setupMode: boolean;
  /** Validation problems that put us in setup mode (empty otherwise). */
  configIssues: string[];
  /** Called after the wizard saves a now-valid config — rebuild the app. */
  onConfigured?: () => void | Promise<void>;
}
