import { beforeEach, describe, expect, it } from "vitest";
import { syntheticPool } from "../shared/allocator";
import { COMPREHENSION, DEMOGRAPHICS } from "../shared/content";
import { parseCsv } from "../scripts/lib/validate";
import { ParticipantState } from "../shared/types";
import * as svc from "../server/service";
import { MemoryStore } from "../server/store";

const POOL = syntheticPool({ a: 60, b: 30, c: 30, d: 60, e: 30, f: 30, g: 60 });
let clock = 1_800_000_000_000;
let ctx: svc.Context;

function makeContext(latency = 0): svc.Context {
  return { store: new MemoryStore(latency), pool: POOL, rng: Math.random, now: () => clock, demoMode: true };
}

beforeEach(() => {
  ctx = makeContext();
});

const enter = (pid: string) => svc.enter(ctx, { pid, studyId: "STUDY", sessionId: `SES_${pid}`, source: "demo" });

async function toPractice(pid: string) {
  await enter(pid);
  await svc.submitStage(ctx, pid, "consent", { agree: true });
  await svc.submitStage(ctx, pid, "instructions", {});
  return svc.submitStage(ctx, pid, "comprehension", { value: COMPREHENSION.correct });
}

async function toMain(pid: string) {
  let state = await toPractice(pid);
  while (state.stage === "practice") state = await answerTrial(pid, state);
  return state;
}

function answerTrial(pid: string, state: ParticipantState, value?: "B" | "C" | "equal" | "cannot_judge") {
  const trial = state.trial!;
  const chosen = value ?? (trial.demo?.expected as "B" | "C" | undefined) ?? "B";
  return svc.answer(ctx, { pid, trialNo: trial.no, kind: trial.kind, value: chosen, rtMs: 1234, zoomCount: 0 });
}

async function finishMain(pid: string, state: ParticipantState) {
  while (state.stage === "main") state = await answerTrial(pid, state);
  return state;
}

async function finishSurvey(pid: string) {
  await svc.submitStage(ctx, pid, "post_aspects", { values: ["room_sizes", "other"], other: "=cmd()" });
  await svc.submitStage(ctx, pid, "post_most", { value: "room_sizes" });
  await svc.submitStage(ctx, pid, "post_difficulty", { value: "3" });
  await svc.submitStage(ctx, pid, "post_comments", { text: "fine" });
  return svc.submitStage(ctx, pid, "demographics", { answers: Object.fromEntries(DEMOGRAPHICS.map((q) => [q.id, q.options[0]])) });
}

describe("participant flow", () => {
  it("runs the whole study: 42 questions with checks at 16 and 31", async () => {
    let state = await toMain("P1");
    const kinds: string[] = [];
    const seen = new Set<string>();
    while (state.stage === "main") {
      expect(state.trial).not.toBeNull();
      kinds.push(state.trial!.kind);
      if (state.trial!.kind === "main") seen.add(state.trial!.demo!.tripletId);
      state = await answerTrial("P1", state);
    }
    expect(kinds).toHaveLength(42);
    expect(kinds[15]).toBe("attention");
    expect(kinds[30]).toBe("attention");
    expect(kinds.filter((k) => k === "main")).toHaveLength(40);
    expect(seen.size).toBe(40);
    const final = await finishSurvey("P1");
    expect(final.status).toBe("completed");
    expect(final.completionUrl).toContain("cc=");
  });

  it("gives the N=40 quota of 8/4/4/8/4/4/8 per participant", async () => {
    let state = await toMain("P1");
    const counts: Record<string, number> = {};
    while (state.stage === "main") {
      if (state.trial!.kind === "main") counts[state.trial!.demo!.condition] = (counts[state.trial!.demo!.condition] ?? 0) + 1;
      state = await answerTrial("P1", state);
    }
    expect(counts).toEqual({ a: 8, b: 4, c: 4, d: 8, e: 4, f: 4, g: 8 });
  });

  it("ends after two comprehension failures and stays ended on re-entry", async () => {
    await enter("P1");
    await svc.submitStage(ctx, "P1", "consent", { agree: true });
    await svc.submitStage(ctx, "P1", "instructions", {});
    let state = await svc.submitStage(ctx, "P1", "comprehension", { value: "prefer" });
    expect(state.stage).toBe("comprehension");
    expect(state.comprehensionAttempts).toBe(1);
    state = await svc.submitStage(ctx, "P1", "comprehension", { value: "fashion" });
    expect(state.stage).toBe("ended_comprehension");
    expect((await enter("P1")).stage).toBe("ended_comprehension");
  });

  it("lets a decliner return to consent", async () => {
    await enter("P1");
    const state = await svc.submitStage(ctx, "P1", "consent", { agree: false });
    expect(state.stage).toBe("ended_declined");
    expect((await enter("P1")).stage).toBe("consent");
  });

  it("does not let a completed participant answer again", async () => {
    await finishMain("P1", await toMain("P1"));
    await finishSurvey("P1");
    const again = await enter("P1");
    expect(again.alreadyCompleted).toBe(true);
    expect(again.trial).toBeNull();
    const before = (await svc.allSessions(ctx))[0].responses.length;
    await svc.answer(ctx, { pid: "P1", trialNo: 1, kind: "main", value: "B", rtMs: 1 }).catch(() => undefined);
    await svc.submitStage(ctx, "P1", "post_difficulty", { value: "5" });
    expect((await svc.allSessions(ctx))[0].responses.length).toBe(before);
  });

  it("blocks new entrants while paused but keeps those already inside", async () => {
    const state = await toMain("P1");
    await svc.updateSettings(ctx, { paused: true });
    expect((await enter("P2")).paused).toBe(true);
    const next = await answerTrial("P1", state);
    expect(next.trial!.no).toBe(state.trial!.no + 1);
    await svc.updateSettings(ctx, { paused: false });
    expect((await enter("P2")).paused).toBeUndefined();
  });

  it("refuses to change N once a participant exists", async () => {
    await svc.updateSettings(ctx, { n: 20 });
    await enter("P1");
    await expect(svc.updateSettings(ctx, { n: 30 })).rejects.toMatchObject({ code: "study_started" });
    await svc.resetAll(ctx);
    await expect(svc.updateSettings(ctx, { n: 30 })).resolves.toMatchObject({ n: 30 });
  });

  it("uses the N set by the administrator", async () => {
    await svc.updateSettings(ctx, { n: 10 });
    let state = await toMain("P1");
    let total = 0;
    while (state.stage === "main") {
      total++;
      expect(state.trial!.total).toBe(12);
      state = await answerTrial("P1", state);
    }
    expect(total).toBe(12);
  });
});

describe("saving", () => {
  it("is idempotent: a resent answer is stored and counted once", async () => {
    const state = await toMain("P1");
    const payload = { pid: "P1", trialNo: state.trial!.no, kind: "main", value: "B" as const, rtMs: 900 };
    const first = await svc.answer(ctx, payload);
    const second = await svc.answer(ctx, payload);
    expect(second.duplicate).toBe(true);
    expect(second.trial!.no).toBe(first.trial!.no);
    const check = await svc.reconcile(ctx, false);
    expect(check.savedResponses).toBe(1);
    expect(check.mismatchedItems).toBe(0);
  });

  it("recovers when the server dies after saving but before counting", async () => {
    const state = await toMain("P1");
    const store = ctx.store as MemoryStore;
    const realPut = store.put.bind(store);
    store.put = async (key, text, options) => {
      if (key === "ledger") throw new Error("crash");
      return realPut(key, text, options);
    };
    await expect(svc.answer(ctx, { pid: "P1", trialNo: state.trial!.no, kind: "main", value: "C", rtMs: 900 })).rejects.toThrow("crash");
    store.put = realPut;
    const session = (await svc.allSessions(ctx))[0];
    expect(session.responses.filter((r) => r.kind === "main")).toHaveLength(1);
    const resumed = await enter("P1");
    expect(resumed.trial!.no).toBe(state.trial!.no + 1);
    const check = await svc.reconcile(ctx, false);
    expect(check.savedResponses).toBe(1);
    expect(check.mismatchedItems).toBe(0);
  });

  it("records the correct selected image under both label modes", async () => {
    for (const labelMode of ["follow_image", "fixed_position"] as const) {
      ctx = makeContext();
      await svc.updateSettings(ctx, { labelMode });
      const state = await toMain("P1");
      await answerTrial("P1", state, "B");
      const row = (await svc.allSessions(ctx))[0].responses.find((r) => r.kind === "main")!;
      const shownLeft = row.leftLabel === "B";
      expect(row.selectedImageId).toBe(shownLeft ? row.leftImageId : row.rightImageId);
      if (labelMode === "follow_image") expect(row.selectedImageId).toBe(row.bId);
      else expect(row.selectedImageId).toBe(row.leftImageId);
    }
  });

  it("marks attention checks by label and never sends the answer key outside demo mode", async () => {
    ctx = { ...makeContext(), demoMode: false };
    await svc.updateSettings(ctx, { completionUrl: "https://example.org/done" });
    let state = await toMain("P1");
    while (state.trial!.kind !== "attention") {
      expect(JSON.stringify(state.trial)).not.toContain("expected");
      state = await answerTrial("P1", state);
    }
    expect(JSON.stringify(state.trial)).not.toContain("expected");
    expect(state.trial!.demo).toBeUndefined();
    state = await svc.answer(ctx, { pid: "P1", trialNo: state.trial!.no, kind: "attention", value: "C", rtMs: 1 });
    const session = (await svc.allSessions(ctx))[0];
    expect(session.attentionFailed).toBe(1);
    expect(session.responses.at(-1)!.correct).toBe(false);
  });

  it("exports every saved answer: rows, identifiers and values match", async () => {
    const state = await finishMain("P1", await toMain("P1"));
    expect(state.stage).toBe("post_aspects");
    await finishSurvey("P1");
    const session = (await svc.allSessions(ctx))[0];
    const table = parseCsv(await svc.exportCsv(ctx, "responses", false));
    const header = table[0];
    const rows = table.slice(1);
    expect(rows).toHaveLength(session.responses.length);
    const col = (row: string[], name: string) => row[header.indexOf(name)];
    session.responses.forEach((saved, i) => {
      expect(col(rows[i], "prolific_pid")).toBe("P1");
      expect(col(rows[i], "study_id")).toBe("STUDY");
      expect(col(rows[i], "session_id")).toBe("SES_P1");
      expect(col(rows[i], "screen_id")).toBe(saved.screenId);
      expect(col(rows[i], "question_id")).toBe(saved.questionId);
      expect(col(rows[i], "response_value")).toBe(saved.value);
      expect(col(rows[i], "triplet_id")).toBe(saved.tripletId ?? "");
      expect(col(rows[i], "selected_image_id")).toBe(saved.selectedImageId ?? "");
    });
  });

  it("neutralizes spreadsheet formulas in free text", async () => {
    await finishMain("P1", await toMain("P1"));
    await finishSurvey("P1");
    const table = parseCsv(await svc.exportCsv(ctx, "responses", false));
    const textColumn = table[0].indexOf("response_text");
    expect(table.some((row) => row[textColumn] === "'=cmd()")).toBe(true);
  });
});

describe("dropout and re-entry", () => {
  it("releases on browser back at once, and the question is reused", async () => {
    const state = await toMain("P1");
    const held = state.trial!.demo!.tripletId;
    await svc.leave(ctx, "P1", "back");
    const summary = await svc.adminSummary(ctx);
    expect(summary.balance.reserved).toBe(0);
    expect(summary.participants.dropped).toBe(1);
    const again = await enter("P1");
    expect(again.trial!.no).toBe(state.trial!.no);
    expect(again.trial!.demo!.tripletId).not.toBe(held);
  });

  it("survives a reload inside the grace period with the same question", async () => {
    const state = await toMain("P1");
    await svc.leave(ctx, "P1", "pagehide");
    clock += 5_000;
    const again = await enter("P1");
    expect(again.trial!.demo!.tripletId).toBe(state.trial!.demo!.tripletId);
    clock += 60_000;
    expect((await svc.adminSummary(ctx)).balance.reserved).toBe(1);
  });

  it("releases a closed tab once the grace period passes", async () => {
    await toMain("P1");
    await svc.leave(ctx, "P1", "pagehide");
    clock += 16_000;
    const summary = await svc.adminSummary(ctx);
    expect(summary.balance.reserved).toBe(0);
    expect(summary.releasedNow).toBe(1);
  });

  it("releases when heartbeats stop and keeps the question while they continue", async () => {
    await toMain("P1");
    await svc.heartbeat(ctx, "P1");
    clock += 100_000;
    await svc.heartbeat(ctx, "P1");
    clock += 100_000;
    expect((await svc.adminSummary(ctx)).balance.reserved).toBe(1);
    clock += 125_000;
    expect((await svc.adminSummary(ctx)).balance.reserved).toBe(0);
  });

  it("gives a released question to the next person immediately", async () => {
    ctx = { ...makeContext(), pool: syntheticPool({ a: 2, b: 0, c: 0, d: 0, e: 0, f: 0, g: 0 }) };
    await svc.updateSettings(ctx, { n: 1 });
    const trialOf = async (pid: string) => {
      let state = await toMain(pid);
      while (state.trial!.kind !== "main") state = await answerTrial(pid, state);
      return state.trial!.demo!.tripletId;
    };
    const held = await trialOf("P1");
    const other = await trialOf("P2");
    expect(other).not.toBe(held);
    await svc.leave(ctx, "P1", "back");
    expect(await trialOf("P3")).toBe(held);
  });

  it("still saves an answer that arrives after its question was released", async () => {
    const state = await toMain("P1");
    await svc.leave(ctx, "P1", "back");
    const next = await answerTrial("P1", state);
    expect(next.trial!.no).toBe(state.trial!.no + 1);
    const session = (await svc.allSessions(ctx))[0];
    expect(session.responses.find((r) => r.kind === "main")!.lateAfterRelease).toBe(true);
    expect((await svc.reconcile(ctx, false)).mismatchedItems).toBe(0);
  });

  it("does not repeat answered questions after re-entry and keeps the plan size", async () => {
    let state = await toMain("P1");
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      if (state.trial!.kind === "main") seen.add(state.trial!.demo!.tripletId);
      state = await answerTrial("P1", state);
    }
    await svc.leave(ctx, "P1", "back");
    state = await enter("P1");
    let mainTotal = seen.size;
    while (state.stage === "main") {
      if (state.trial!.kind === "main") {
        expect(seen.has(state.trial!.demo!.tripletId)).toBe(false);
        seen.add(state.trial!.demo!.tripletId);
        mainTotal++;
      }
      state = await answerTrial("P1", state);
    }
    expect(mainTotal).toBe(40);
  });
});

describe("image errors", () => {
  it("replaces the question, logs it, and blocks after repeated reports", async () => {
    const pool = syntheticPool({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, g: 1 });
    ctx = { ...makeContext(), pool };
    await svc.updateSettings(ctx, { n: 2 });
    const first = await toMain("P1");
    const broken = first.trial!.demo!.tripletId;
    const replaced = await svc.reportImageError(ctx, { pid: "P1", trialNo: first.trial!.no, url: "/x.png" });
    expect(replaced.trial!.no).toBe(first.trial!.no);
    expect(replaced.trial!.demo!.tripletId).not.toBe(broken);
    const summary = await svc.adminSummary(ctx);
    expect(summary.imageErrors).toHaveLength(1);
    expect(summary.balance.blocked).toBe(0);
    await svc.setBlocked(ctx, broken, true);
    expect((await svc.adminSummary(ctx)).balance.blocked).toBe(1);
  });
});

describe("attention exclusion", () => {
  it("removes failers from the question counts when enabled", async () => {
    await svc.updateSettings(ctx, { excludeFailedAttention: true });
    let state = await toMain("P1");
    while (state.stage === "main") {
      const trial = state.trial!;
      state = await answerTrial("P1", state, trial.kind === "attention" ? (trial.demo!.expected === "B" ? "C" : "B") : "B");
    }
    await finishSurvey("P1");
    const summary = await svc.adminSummary(ctx);
    expect(summary.balance.max).toBe(0);
    expect((await svc.reconcile(ctx, false)).mismatchedItems).toBe(0);
  });
});

describe("simultaneous access", () => {
  it("keeps counts exact and balanced with 60 people at once", async () => {
    ctx = makeContext(4);
    const run = async (k: number) => {
      const pid = `C${k}`;
      let state = await toMain(pid);
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) {
        if (state.trial!.kind === "main") {
          expect(seen.has(state.trial!.demo!.tripletId)).toBe(false);
          seen.add(state.trial!.demo!.tripletId);
        }
        state = await answerTrial(pid, state);
      }
      await svc.leave(ctx, pid, "back");
    };
    await Promise.all(Array.from({ length: 60 }, (_, k) => run(k)));
    const check = await svc.reconcile(ctx, false);
    expect(check.mismatchedItems).toBe(0);
    expect(check.duplicateAssignments).toBe(0);
    const summary = await svc.adminSummary(ctx);
    expect(summary.balance.reserved).toBe(0);
    expect(summary.balance.max - summary.balance.min).toBeLessThanOrEqual(2);
  }, 60_000);

  it("creates one session when the same person opens two tabs at once", async () => {
    ctx = makeContext(4);
    const [a, b] = await Promise.all([enter("P1"), enter("P1")]);
    expect(a.pid).toBe(b.pid);
    expect(await svc.allSessions(ctx)).toHaveLength(1);
  });
});

describe("simulated seed", () => {
  it("produces labelled data that agrees with the ledger", async () => {
    await svc.seedSimulated(ctx, 20);
    const check = await svc.reconcile(ctx, false);
    expect(check.mismatchedItems).toBe(0);
    expect(check.savedResponses).toBeGreaterThan(0);
    const funnel = (await svc.adminSummary(ctx)).funnel.map((f) => f.count);
    expect(funnel).toEqual([...funnel].sort((a, b) => b - a));
    const sessions = await svc.allSessions(ctx);
    expect(sessions).toHaveLength(20);
    expect(sessions.every((s) => s.source === "simulated")).toBe(true);
    expect(parseCsv(await svc.exportCsv(ctx, "responses", true))).toHaveLength(1);
  });
});
