/**
 * Validates client data and, with --apply, installs it for the next build.
 *
 *   npm run import -- --zip RPLAN.zip
 *   npm run import -- --csv triplets.csv --images RPLAN_triplets --apply
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { directorySource, zipSource } from "./lib/sources";
import { ImageSource, validateImport } from "./lib/validate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

let source: ImageSource;
let csvText: string | null;
const zip = option("zip");
if (zip) {
  const opened = zipSource(zip);
  source = opened.source;
  csvText = option("csv") ? readFileSync(option("csv")!, "utf8") : opened.csv;
} else if (option("csv") && option("images")) {
  source = directorySource(option("images")!);
  csvText = readFileSync(option("csv")!, "utf8");
} else {
  console.error("Usage: npm run import -- --zip file.zip [--csv file.csv] [--apply]\n       npm run import -- --csv file.csv --images dir [--apply]");
  process.exit(2);
}
if (!csvText) {
  console.error("No CSV found. Pass one with --csv.");
  process.exit(2);
}

const { report, rows } = validateImport(csvText, source);
console.log(`Rows: ${report.rows}  Valid triplets: ${report.validTriplets}  Valid images: ${report.imagesValid}/${report.imagesExpected}`);
console.log("Conditions:", report.conditionCounts);
if (Object.keys(report.errorCounts).length) console.log("Errors:", report.errorCounts);
if (Object.keys(report.warningCounts).length) console.log("Warnings:", report.warningCounts);
for (const issue of report.errors.slice(0, 20)) console.log(`  ✗ ${issue.tripletId ?? "-"}: ${issue.type} — ${issue.detail}`);

if (args.includes("--apply")) {
  if (!report.ok) {
    console.error("Not applied: fix the errors above first.");
    process.exit(1);
  }
  const images = join(ROOT, "public", "RPLAN_triplets");
  rmSync(images, { recursive: true, force: true });
  mkdirSync(images, { recursive: true });
  if (option("images")) {
    cpSync(option("images")!, images, { recursive: true });
  } else {
    for (const folder of source.folders()) {
      if (!rows.some((row) => row.id === folder)) continue;
      mkdirSync(join(images, folder), { recursive: true });
      for (const file of ["a.png", "b.png", "c.png"]) writeFileSync(join(images, folder, file), source.read(folder, file)!);
    }
  }
  writeFileSync(join(images, ".generated-v1"), "client data\n");
  writeFileSync(join(ROOT, "data", "triplets.json"), JSON.stringify(rows.map((r) => [r.id, r.anchor, r.b, r.c])));
  writeFileSync(join(ROOT, "data", "import-report.json"), JSON.stringify(report, null, 1));
  console.log("Applied. Set KEEP_CLIENT_DATA=1 on the build so the dummy generator does not overwrite it.");
}
process.exit(report.ok ? 0 : 1);
