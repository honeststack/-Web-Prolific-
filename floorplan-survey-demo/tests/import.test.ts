import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { planPng } from "../scripts/lib/floorplan";
import { checkPng } from "../scripts/lib/png";
import { zipSource } from "../scripts/lib/sources";
import { validateImport } from "../scripts/lib/validate";

const CSV = "triplet_id,anchor_id,b_id,c_id\n10015_a_1,10015,30011,30014\n10015_d_1,10015,30017,30020\n";

function archive(mutate: (files: Record<string, Uint8Array>) => void = () => undefined) {
  const files: Record<string, Uint8Array> = {
    "triplets.csv": new TextEncoder().encode(CSV),
    "RPLAN_triplets/10015_a_1/a.png": planPng(10015),
    "RPLAN_triplets/10015_a_1/b.png": planPng(30011),
    "RPLAN_triplets/10015_a_1/c.png": planPng(30014),
    "RPLAN_triplets/10015_d_1/a.png": planPng(10015),
    "RPLAN_triplets/10015_d_1/b.png": planPng(30017),
    "RPLAN_triplets/10015_d_1/c.png": planPng(30020),
  };
  mutate(files);
  const dir = mkdtempSync(join(tmpdir(), "fp-zip-"));
  const path = join(dir, "data.zip");
  writeFileSync(path, zipSync(files));
  const opened = zipSource(path);
  rmSync(dir, { recursive: true, force: true });
  return opened;
}

describe("ZIP import", () => {
  it("accepts a clean archive and reads its CSV", () => {
    const { source, csv } = archive();
    const { report, rows } = validateImport(csv!, source, 2);
    expect(report.ok).toBe(true);
    expect(rows).toHaveLength(2);
    expect(report.imagesValid).toBe(6);
    expect(report.conditionCounts.a).toBe(1);
    expect(report.uniqueAnchors).toBe(1);
  });

  it("finds missing, truncated and mismatched images", () => {
    const { source, csv } = archive((files) => {
      delete files["RPLAN_triplets/10015_a_1/c.png"];
      files["RPLAN_triplets/10015_a_1/b.png"] = files["RPLAN_triplets/10015_a_1/b.png"].slice(0, 200);
      files["RPLAN_triplets/10015_d_1/a.png"] = planPng(99999);
    });
    const { report } = validateImport(csv!, source, 2);
    expect(report.ok).toBe(false);
    expect(report.errorCounts["画像の欠損"]).toBe(1);
    expect(report.errorCounts["画像の破損"]).toBe(1);
    expect(report.errorCounts["同一IDで画像が異なる"]).toBe(1);
  });
});

describe("PNG check", () => {
  it("accepts generated plans at the expected size", () => {
    expect(checkPng(planPng(10015))).toMatchObject({ ok: true, width: 256, height: 256 });
  });

  it("rejects a flipped byte through the CRC", () => {
    const png = Buffer.from(planPng(10015));
    png[60] ^= 0xff;
    expect(checkPng(png).ok).toBe(false);
  });
});
