import { createHash } from "node:crypto";
import { checkPng } from "./png";
import { conditionOf } from "../../shared/pool";
import { CONDITIONS, Condition } from "../../shared/types";

export interface ImageSource {
  label: string;
  folders(): string[];
  files(folder: string): string[];
  read(folder: string, file: string): Uint8Array | null;
}

export interface ImportIssue {
  type: string;
  tripletId?: string;
  detail: string;
}

export interface ImportReport {
  generatedAt: string;
  source: string;
  ok: boolean;
  rows: number;
  validTriplets: number;
  uniqueAnchors: number;
  imagesExpected: number;
  imagesValid: number;
  conditionCounts: Record<Condition, number>;
  errorCounts: Record<string, number>;
  warningCounts: Record<string, number>;
  errors: ImportIssue[];
  warnings: ImportIssue[];
}

const COLUMNS = ["triplet_id", "anchor_id", "b_id", "c_id"];
const ROLES = [
  { file: "a.png", column: "anchor_id" },
  { file: "b.png", column: "b_id" },
  { file: "c.png", column: "c_id" },
] as const;

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const body = text.replace(/^﻿/, "");
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);
  return rows;
}

export interface ValidRow {
  id: string;
  anchor: string;
  b: string;
  c: string;
}

/** Checks the CSV and the images against each other. Used for real client data and for the dummy set. */
export function validateImport(csvText: string, images: ImageSource, expectedTotal = 3000): { report: ImportReport; rows: ValidRow[] } {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const conditionCounts = Object.fromEntries(CONDITIONS.map((c) => [c, 0])) as Record<Condition, number>;
  const table = parseCsv(csvText);
  const header = (table[0] ?? []).map((h) => h.trim());
  const valid: ValidRow[] = [];
  const seen = new Set<string>();
  const anchors = new Set<string>();
  const hashById = new Map<string, { hash: string; tripletId: string }>();
  const sizes = new Map<string, number>();
  let imagesValid = 0;

  if (COLUMNS.some((c, i) => header[i] !== c)) {
    errors.push({ type: "CSV列が不正", detail: `想定: ${COLUMNS.join(",")} / 実際: ${header.join(",")}` });
  }
  const rows = table.slice(1);
  const folderSet = new Set(images.folders());

  for (const [index, cells] of rows.entries()) {
    const [id = "", anchor = "", b = "", c = ""] = cells.map((value) => value.trim());
    const rowNo = index + 2;
    if (!id || !anchor || !b || !c) {
      errors.push({ type: "CSVの空欄", tripletId: id || undefined, detail: `${rowNo}行目に空欄があります` });
      continue;
    }
    if (seen.has(id)) {
      errors.push({ type: "triplet_id重複", tripletId: id, detail: `${rowNo}行目が既出のIDです` });
      continue;
    }
    seen.add(id);
    const condition = conditionOf(id);
    if (!condition) {
      errors.push({ type: "抽出条件を識別できない", tripletId: id, detail: "IDの形式は <番号>_<a〜g>_<連番> を想定しています" });
      continue;
    }
    if (!id.startsWith(`${anchor}_`)) {
      warnings.push({ type: "IDと基準Aの不一致", tripletId: id, detail: `anchor_id=${anchor}` });
    }
    if (b === c || b === anchor || c === anchor) {
      warnings.push({ type: "A・B・Cに同じID", tripletId: id, detail: `A=${anchor} B=${b} C=${c}` });
    }
    if (!folderSet.has(id)) {
      errors.push({ type: "問題フォルダの欠損", tripletId: id, detail: "画像フォルダがありません" });
      continue;
    }
    let rowOk = true;
    for (const role of ROLES) {
      const imageId = role.column === "anchor_id" ? anchor : role.column === "b_id" ? b : c;
      const data = images.read(id, role.file);
      if (!data) {
        errors.push({ type: "画像の欠損", tripletId: id, detail: `${role.file} がありません` });
        rowOk = false;
        continue;
      }
      const check = checkPng(data);
      if (!check.ok) {
        errors.push({ type: "画像の破損", tripletId: id, detail: `${role.file}: ${check.error}` });
        rowOk = false;
        continue;
      }
      imagesValid++;
      const size = `${check.width}x${check.height}`;
      sizes.set(size, (sizes.get(size) ?? 0) + 1);
      const hash = createHash("sha1").update(data).digest("hex");
      const known = hashById.get(imageId);
      if (known && known.hash !== hash) {
        errors.push({ type: "同一IDで画像が異なる", tripletId: id, detail: `${role.file} (ID ${imageId}) が ${known.tripletId} の画像と一致しません` });
        rowOk = false;
      } else if (!known) {
        hashById.set(imageId, { hash, tripletId: id });
      }
    }
    if (rowOk) {
      valid.push({ id, anchor, b, c });
      anchors.add(anchor);
      conditionCounts[condition]++;
    }
  }

  for (const folder of folderSet) {
    if (!seen.has(folder)) warnings.push({ type: "CSVにないフォルダ", tripletId: folder, detail: "問題として使用されません" });
  }
  if (sizes.size > 1) {
    warnings.push({ type: "画像サイズの混在", detail: [...sizes].map(([size, count]) => `${size}: ${count}枚`).join(" / ") });
  }
  if (expectedTotal && rows.length !== expectedTotal) {
    warnings.push({ type: "問題数が想定と異なる", detail: `想定 ${expectedTotal} 組 / 実際 ${rows.length} 組` });
  }

  const tally = (issues: ImportIssue[]) => {
    const out: Record<string, number> = {};
    for (const issue of issues) out[issue.type] = (out[issue.type] ?? 0) + 1;
    return out;
  };
  return {
    rows: valid,
    report: {
      generatedAt: new Date().toISOString(),
      source: images.label,
      ok: errors.length === 0,
      rows: rows.length,
      validTriplets: valid.length,
      uniqueAnchors: anchors.size,
      imagesExpected: rows.length * 3,
      imagesValid,
      conditionCounts,
      errorCounts: tally(errors),
      warningCounts: tally(warnings),
      errors: errors.slice(0, 200),
      warnings: warnings.slice(0, 200),
    },
  };
}
