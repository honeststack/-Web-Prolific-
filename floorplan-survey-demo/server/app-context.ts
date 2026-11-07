import defectReport from "../data/defect-report.json";
import importReport from "../data/import-report.json";
import triplets from "../data/triplets.json";
import { ApiConfig, DEFAULT_DEMO_PASSWORD, poolFromRows } from "./api";
import { Context } from "./service";
import { DocStore } from "./store";

const pool = poolFromRows(triplets as string[][]);

export function buildContext(store: DocStore, env: Record<string, string | undefined>): { ctx: Context; config: ApiConfig } {
  const demoMode = env.DEMO_MODE !== "false";
  const password = env.ADMIN_PASSWORD;
  if (!password && !demoMode) throw new Error("ADMIN_PASSWORD must be set when DEMO_MODE=false.");
  return {
    ctx: { store, pool, rng: Math.random, now: Date.now, demoMode, importReport, defectReport },
    config: { adminPassword: password || DEFAULT_DEMO_PASSWORD, usingDefaultPassword: !password },
  };
}
