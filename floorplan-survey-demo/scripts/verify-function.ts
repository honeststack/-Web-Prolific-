/**
 * Bundles netlify/functions/api.ts the way Netlify does (esbuild, Node, ESM), then
 * drives the bundle with real Requests. Blobs configuration arrives through
 * NETLIFY_BLOBS_CONTEXT, as it does on Netlify, and points at the local Blobs server.
 *   npm run verify:function
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BlobsServer } from "@netlify/blobs/server";
import { build } from "esbuild";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "fp-fn-"));
const outfile = join(work, "api.mjs");

await build({
  entryPoints: [join(ROOT, "netlify/functions/api.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile,
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
});
console.log(`Bundle: ${(statSync(outfile).size / 1024).toFixed(0)} KB`);

const server = new BlobsServer({ directory: join(work, "blobs"), token: "t", port: 0 });
const { port } = await server.start();
const url = `http://localhost:${port}`;
process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: url, uncachedEdgeURL: url, siteID: "site", token: "t", deployID: "d" })).toString("base64");

const fn = await import(pathToFileURL(outfile).href);
const site = "https://example.netlify.app";
const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const response: Response = await fn.default(new Request(`${site}/api${path}`, body === undefined ? { headers } : { method: "POST", body: JSON.stringify(body), headers }));
  return { status: response.status, type: response.headers.get("content-type"), text: await response.text() };
};

let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok ? "" : ` ${detail}`}`);
  if (!ok) failed++;
};

check("route config is /api/*", fn.config?.path === "/api/*");
const info = await call("/info");
check("info answers", info.status === 200 && JSON.parse(info.text).poolSize === 3000, info.text);
const pid = "FNTEST";
let r = await call("/session/enter", { pid, studyId: "S", sessionId: "X", source: "demo" });
check("participant enters", r.status === 200 && JSON.parse(r.text).stage === "consent", r.text);
await call("/session/stage", { pid, stage: "consent", payload: { agree: true } });
await call("/session/stage", { pid, stage: "instructions", payload: {} });
r = await call("/session/stage", { pid, stage: "comprehension", payload: { value: "more_similar" } });
let state = JSON.parse(r.text);
check("reaches practice", state.stage === "practice", r.text);
for (let i = 0; i < 4; i++) {
  r = await call("/session/answer", { pid, trialNo: state.trial.no, kind: state.trial.kind, value: "B", rtMs: 1000 });
  state = JSON.parse(r.text);
}
check("two main answers saved, on question 3", state.trial?.no === 3 && state.trial?.kind === "main", r.text);
check("admin refuses a wrong password", (await call("/admin/summary", undefined, { "x-admin-password": "wrong" })).status === 401);
const admin = { "x-admin-password": JSON.parse(info.text).demoPassword };
const summary = await call("/admin/summary", undefined, admin);
check("admin summary sees the answers", JSON.parse(summary.text).responses?.main === 2, summary.text.slice(0, 300));
const csv = await call("/admin/export?type=responses", undefined, admin);
check("CSV export", csv.status === 200 && csv.type?.startsWith("text/csv") === true && csv.text.includes("FNTEST"));
const check2 = await call("/admin/reconcile", {}, admin);
check("saved answers match the ledger", JSON.parse(check2.text).mismatchedItems === 0, check2.text);
check("unknown route is 404", (await call("/nope")).status === 404);

await server.stop();
rmSync(work, { recursive: true, force: true });
console.log(failed ? `${failed} FAILED` : "All function checks passed");
process.exit(failed ? 1 : 0);
