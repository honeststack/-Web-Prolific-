import { ItemRow, ResponseRow, Session } from "./types";

/**
 * Free text starting with these characters would run as a formula when the file
 * is opened in Excel, so it is prefixed with an apostrophe. Identifiers and
 * numbers are never altered.
 */
function neutralizeFormula(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function cell(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.join(","), ...rows.map((row) => row.map(cell).join(","))];
  // The BOM makes Excel on Japanese Windows read the file as UTF-8.
  return `﻿${lines.join("\r\n")}\r\n`;
}

export const RESPONSE_COLUMNS = [
  "prolific_pid",
  "study_id",
  "session_id",
  "phase",
  "source",
  "screen_id",
  "question_id",
  "row_type",
  "trial_no",
  "triplet_id",
  "condition",
  "anchor_id",
  "b_id",
  "c_id",
  "left_image_id",
  "right_image_id",
  "left_label",
  "right_label",
  "response_value",
  "response_text",
  "selected_image_id",
  "is_correct",
  "rt_ms",
  "images_shown_at",
  "answered_at",
  "zoom_count",
  "assignment_reason",
  "late_after_release",
  "autofilled",
  "participant_status",
];

function responseCells(session: Session, row: ResponseRow): unknown[] {
  return [
    session.pid,
    session.studyId,
    row.sessionId,
    session.phase,
    session.source,
    row.screenId,
    row.questionId,
    row.kind,
    row.trialNo,
    row.tripletId,
    row.condition,
    row.anchorId,
    row.bId,
    row.cId,
    row.leftImageId,
    row.rightImageId,
    row.leftLabel,
    row.rightLabel,
    row.value,
    row.text === undefined ? undefined : neutralizeFormula(row.text),
    row.selectedImageId,
    row.correct,
    row.rtMs,
    row.imagesShownAt,
    row.answeredAt,
    row.zoomCount,
    row.assignmentReason,
    row.lateAfterRelease,
    row.autofilled,
    session.status,
  ];
}

/** Long format: one row per answer on any screen. */
export function responsesCsv(sessions: Session[]): string {
  return toCsv(
    RESPONSE_COLUMNS,
    sessions.flatMap((session) => session.responses.map((row) => responseCells(session, row))),
  );
}

export function participantsCsv(sessions: Session[]): string {
  return toCsv(
    [
      "prolific_pid",
      "study_id",
      "session_ids",
      "phase",
      "source",
      "status",
      "stage",
      "n",
      "main_answered",
      "comprehension_attempts",
      "attention_passed",
      "attention_failed",
      "excluded_from_balance",
      "access_count",
      "created_at",
      "completed_at",
      "updated_at",
      "events",
    ],
    sessions.map((s) => [
      s.pid,
      s.studyId,
      s.sessionIds.join(" "),
      s.phase,
      s.source,
      s.status,
      s.stage,
      s.n,
      s.responses.filter((r) => r.kind === "main").length,
      s.comprehensionAttempts,
      s.attentionPassed,
      s.attentionFailed,
      s.excludedFromBalance,
      s.accessCount,
      s.createdAt,
      s.completedAt,
      s.updatedAt,
      s.events.map((e) => `${e.at} ${e.type}${e.detail ? `(${e.detail})` : ""}`).join(" | "),
    ]),
  );
}

export function itemsCsv(items: ItemRow[]): string {
  return toCsv(
    ["triplet_id", "condition", "anchor_id", "answered", "open_now", "image_error_reports", "blocked"],
    items.map((i) => [i.id, i.condition, i.anchorId, i.answered, i.reserved, i.errorReports, i.blocked]),
  );
}
