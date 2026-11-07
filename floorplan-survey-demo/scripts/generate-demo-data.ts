/**
 * Creates the dummy data set: 3,000 triplets, 9,000 PNGs in the client's folder
 * layout, the practice and attention items, and two import reports (the clean set
 * and a deliberately damaged one that shows what the validator catches).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32, shuffle } from "../shared/allocator";
import { CONDITIONS, Condition } from "../shared/types";
import { planPng } from "./lib/floorplan";
import { directorySource } from "./lib/sources";
import { validateImport } from "./lib/validate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const IMAGES = join(ROOT, "public", "RPLAN_triplets");
const EXTRA = join(ROOT, "public", "survey_items");
const STAMP = join(IMAGES, ".generated-v1");

if (process.env.KEEP_CLIENT_DATA === "1") {
  console.log("KEEP_CLIENT_DATA=1: using the imported client data.");
  process.exit(0);
}

const COUNTS: Record<Condition, number> = { a: 600, b: 300, c: 300, d: 600, e: 300, f: 300, g: 600 };
const ANCHOR_COUNT = 600;
const OTHER_PLANS = 1800;

const rng = mulberry32(20261130);
const pngCache = new Map<string, Buffer>();
function imageFor(id: string): Buffer {
  let png = pngCache.get(id);
  if (!png) {
    png = planPng(Number(id));
    pngCache.set(id, png);
  }
  return png;
}

const anchors = Array.from({ length: ANCHOR_COUNT }, (_, i) => String(10015 + i * 7));
const others = Array.from({ length: OTHER_PLANS }, (_, i) => String(30011 + i * 3));

const conditionList = shuffle(CONDITIONS.flatMap((c) => Array.from({ length: COUNTS[c] }, () => c)), rng);
const sequence = new Map<string, number>();
const rows = conditionList.map((cond, i) => {
  const anchor = anchors[i % ANCHOR_COUNT];
  const key = `${anchor}_${cond}`;
  const seq = (sequence.get(key) ?? 0) + 1;
  sequence.set(key, seq);
  const b = others[Math.floor(rng() * OTHER_PLANS)];
  let c = others[Math.floor(rng() * OTHER_PLANS)];
  if (c === b) c = others[(others.indexOf(b) + 1) % OTHER_PLANS];
  return { id: `${key}_${seq}`, anchor, b, c };
});

function writeTriplet(root: string, row: { id: string; anchor: string; b: string; c: string }) {
  const folder = join(root, row.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "a.png"), imageFor(row.anchor));
  writeFileSync(join(folder, "b.png"), imageFor(row.b));
  writeFileSync(join(folder, "c.png"), imageFor(row.c));
}

function csvOf(list: { id: string; anchor: string; b: string; c: string }[]): string {
  return ["triplet_id,anchor_id,b_id,c_id", ...list.map((r) => `${r.id},${r.anchor},${r.b},${r.c}`)].join("\n") + "\n";
}

mkdirSync(DATA, { recursive: true });
const csv = csvOf(rows);

if (!existsSync(STAMP)) {
  console.log("Writing 9,000 dummy floor plans…");
  rmSync(IMAGES, { recursive: true, force: true });
  mkdirSync(IMAGES, { recursive: true });
  for (const row of rows) writeTriplet(IMAGES, row);
  writeFileSync(STAMP, "dummy data v1\n");
} else {
  console.log("Dummy floor plans already present.");
}

rmSync(EXTRA, { recursive: true, force: true });
for (const [i, id] of ["practice_1", "practice_2", "attention_1", "attention_2", "instructions"].entries()) {
  const folder = join(EXTRA, id);
  mkdirSync(folder, { recursive: true });
  ["a", "b", "c"].forEach((role, r) => writeFileSync(join(folder, `${role}.png`), planPng(70001 + i * 10 + r)));
}

writeFileSync(join(DATA, "triplets.csv"), csv);
writeFileSync(join(DATA, "triplets.json"), JSON.stringify(rows.map((r) => [r.id, r.anchor, r.b, r.c])));

const clean = validateImport(csv, { ...directorySource(IMAGES), label: "ダミーデータ（RPLAN_triplets と同じ構成）" });
writeFileSync(join(DATA, "import-report.json"), JSON.stringify(clean.report, null, 1));
console.log(`Clean set: ok=${clean.report.ok}, ${clean.report.validTriplets} triplets, ${clean.report.imagesValid} valid images`);

// A small damaged set proving the validator finds each kind of fault.
const defectRoot = mkdtempSync(join(tmpdir(), "fp-defects-"));
try {
  const sample = rows.slice(0, 12);
  for (const row of sample) writeTriplet(defectRoot, row);
  const pick = (i: number) => join(defectRoot, sample[i].id);
  rmSync(join(pick(0), "c.png"));
  const whole = readFileSync(join(pick(1), "a.png"));
  writeFileSync(join(pick(1), "a.png"), whole.subarray(0, Math.floor(whole.length / 2)));
  writeFileSync(join(pick(2), "b.png"), Buffer.from("this is not an image"));
  rmSync(pick(3), { recursive: true });
  mkdirSync(join(defectRoot, "99999_a_1"));
  const defectRows = [...sample];
  defectRows.push({ ...sample[4] });
  defectRows.push({ id: "10015_x_9", anchor: "10015", b: sample[5].b, c: sample[5].c });
  defectRows.push({ id: "", anchor: "", b: "1", c: "2" });
  const { report } = validateImport(csvOf(defectRows), { ...directorySource(defectRoot), label: "検出確認用の破損サンプル（意図的に破損）" }, 12);
  writeFileSync(join(DATA, "defect-report.json"), JSON.stringify(report, null, 1));
  console.log(`Damaged set: found ${report.errors.length} errors, ${report.warnings.length} warnings`);
} finally {
  rmSync(defectRoot, { recursive: true, force: true });
}
