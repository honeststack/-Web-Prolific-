/**
 * Runs virtual participants against a running site, then recounts the saved data.
 *   npm run loadtest -- https://your-site.netlify.app --participants 30 --questions 10
 *
 * Test participants are labelled `loadtest` in the data. Use the admin reset afterwards.
 */
import { runLoadTest } from "../shared/driver";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "http://localhost:8787").replace(/\/$/, "");
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const password = process.env.ADMIN_PASSWORD ?? "demo-admin";

const result = await runLoadTest({
  baseUrl: base,
  participants: option("participants", 30),
  questionsEach: option("questions", 10),
});

const { assignments: _assignments, pids: _pids, ...report } = result;
console.log(report);
const reconcile = await fetch(`${base}/api/admin/reconcile`, {
  method: "POST",
  headers: { "x-admin-password": password, "content-type": "application/json" },
  body: "{}",
});
const check = reconcile.ok ? await reconcile.json() : { skipped: `admin check failed: HTTP ${reconcile.status}` };
console.log("Saved answers vs assignment ledger:", check);
const bad = result.failures > 0 || result.duplicateWithinParticipant > 0 || check.mismatchedItems > 0;
console.log(bad ? "RESULT: PROBLEMS FOUND" : "RESULT: OK");
process.exit(bad ? 1 : 0);
