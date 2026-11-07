/**
 * Survey state machine and assignment transactions.
 *
 * Every write that decides an assignment goes through compare-and-swap on the
 * ledger document, so two people can never be handed a decision based on the same
 * stale counts: the second writer's etag is refused and it recomputes.
 *
 * An answer is saved in three idempotent steps, which is what makes a retry safe:
 *   A. append the row to the participant's session  (the data is now durable)
 *   B. in one ledger transaction: count it, release the question, lease the next
 *   C. record the new question on the session
 */
import {
  attentionPositions,
  balanceStats,
  conditionPlan,
  consumePlan,
  emptyLedger,
  histogram,
  pickNext,
  Rng,
} from "../shared/allocator";
import {
  ASPECTS,
  ATTENTION_ITEMS,
  COMPREHENSION,
  DEMOGRAPHICS,
  DIFFICULTY,
  EXTRA_ITEMS_BASE,
  MAIN_PROMPT,
  PRACTICE_ITEMS,
  PRACTICE_PROMPTS,
  attentionPrompt,
} from "../shared/content";
import { itemsCsv, participantsCsv, responsesCsv } from "../shared/csv";
import {
  AdminSummary,
  CONDITIONS,
  CONDITION_WEIGHTS,
  Condition,
  ImageErrorRecord,
  ItemRow,
  Ledger,
  ParticipantState,
  PoolItem,
  PublicTrial,
  ResponseRow,
  ResponseValue,
  Session,
  SessionSource,
  SessionStatus,
  SessionSummary,
  Settings,
  Stage,
  Trial,
} from "../shared/types";
import { DocStore } from "./store";

const KEY_SETTINGS = "settings";
const KEY_LEDGER = "ledger";
const KEY_ERRORS = "image-errors";
const PREFIX_SESSION = "session/";
const PREFIX_BEAT = "beat/";
const CAS_BUDGET_MS = 8000;
const READ_CONCURRENCY = 16;

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface Context {
  store: DocStore;
  pool: PoolItem[];
  rng: Rng;
  now: () => number;
  demoMode: boolean;
  importReport?: unknown;
  defectReport?: unknown;
}

export function defaultSettings(now: number, demoMode: boolean): Settings {
  return {
    n: 40,
    completionUrl: demoMode ? "/completion-preview?cc=DEMO1234" : "",
    paused: false,
    phase: "pilot",
    labelMode: "follow_image",
    balanceTolerance: 1,
    heartbeatTimeoutSec: 120,
    idleTimeoutSec: 900,
    leaveGraceSec: 15,
    redirectSeconds: 5,
    excludeFailedAttention: false,
    imageErrorBlockThreshold: 2,
    updatedAt: new Date(now).toISOString(),
  };
}

const iso = (ctx: Context) => new Date(ctx.now()).toISOString();

async function readJson<T>(ctx: Context, key: string): Promise<T | null> {
  const doc = await ctx.store.get(key);
  return doc ? (JSON.parse(doc.text) as T) : null;
}

/** Read-modify-write that retries on conflict. Returning null from `mutate` means no write. */
async function transact<T>(ctx: Context, key: string, create: () => T, mutate: (value: T) => Promise<T | null> | T | null): Promise<T> {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    const doc = await ctx.store.get(key);
    const value = doc ? (JSON.parse(doc.text) as T) : create();
    const next = await mutate(value);
    if (next === null) return value;
    const text = JSON.stringify(next);
    const committed = doc ? await ctx.store.put(key, text, { ifMatch: doc.etag }) : await ctx.store.put(key, text, { ifNew: true });
    if (committed) return next;
    if (Date.now() - started > CAS_BUDGET_MS) throw new ApiError(503, "busy", "The server is busy. Retrying.");
    const backoff = Math.min(400, 12 * 2 ** Math.min(attempt, 5));
    await new Promise((resolve) => setTimeout(resolve, Math.random() * backoff));
  }
}

async function mapLimit<T, R>(values: T[], limit: number, fn: (value: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        out[index] = await fn(values[index]);
      }
    }),
  );
  return out;
}

export async function getSettings(ctx: Context): Promise<Settings> {
  const saved = await readJson<Partial<Settings>>(ctx, KEY_SETTINGS);
  return { ...defaultSettings(ctx.now(), ctx.demoMode), ...saved };
}

const sessionKey = (pid: string) => `${PREFIX_SESSION}${pid}`;
const beatKey = (pid: string) => `${PREFIX_BEAT}${pid}`;

async function getSession(ctx: Context, pid: string): Promise<Session | null> {
  return readJson<Session>(ctx, sessionKey(pid));
}

async function requireSession(ctx: Context, pid: string): Promise<Session> {
  const session = await getSession(ctx, pid);
  if (!session) throw new ApiError(404, "unknown_participant");
  return session;
}

async function updateSession(ctx: Context, pid: string, mutate: (s: Session) => Session | null): Promise<Session> {
  return transact<Session>(
    ctx,
    sessionKey(pid),
    () => {
      throw new ApiError(404, "unknown_participant");
    },
    (s) => {
      const next = mutate(s);
      if (next) next.updatedAt = iso(ctx);
      return next;
    },
  );
}

function logEvent(ctx: Context, session: Session, type: string, detail?: string) {
  session.events.push({ at: iso(ctx), type, detail });
  if (session.events.length > 60) session.events.splice(0, session.events.length - 60);
}

const blankLedger = (ctx: Context) => emptyLedger(ctx.pool.length);

/* ------------------------------- release rules ------------------------------ */

type ReleaseReason = "tab_closed" | "idle_timeout" | "heartbeat_lost";

/** Applies the release rules to a ledger inside a transaction. Returns who lost a question. */
async function sweep(ctx: Context, ledger: Ledger, settings: Settings): Promise<{ pid: string; reason: ReleaseReason }[]> {
  const now = ctx.now();
  const released: { pid: string; reason: ReleaseReason }[] = [];
  for (const [pid, lease] of Object.entries(ledger.leases)) {
    let reason: ReleaseReason | null = null;
    if (lease.leavingAt !== undefined && now - lease.leavingAt >= settings.leaveGraceSec * 1000) reason = "tab_closed";
    else if (now - lease.leasedAt >= settings.idleTimeoutSec * 1000) reason = "idle_timeout";
    else if (now - lease.leasedAt >= settings.heartbeatTimeoutSec * 1000) {
      const beat = await readJson<{ at: number }>(ctx, beatKey(pid));
      if (!beat || now - beat.at >= settings.heartbeatTimeoutSec * 1000) reason = "heartbeat_lost";
    }
    if (reason) {
      ledger.reserved[lease.item] = Math.max(0, ledger.reserved[lease.item] - 1);
      delete ledger.leases[pid];
      ledger.releasedTotal++;
      released.push({ pid, reason });
    }
  }
  return released;
}

async function markReleased(ctx: Context, released: { pid: string; reason: string }[]) {
  await mapLimit(released, READ_CONCURRENCY, async ({ pid, reason }) => {
    await updateSession(ctx, pid, (s) => {
      if (s.status !== "in_progress") return null;
      s.status = "dropped";
      logEvent(ctx, s, "dropped", reason);
      return s;
    }).catch(() => undefined);
  });
}

/* --------------------------------- trials ---------------------------------- */

function buildImageTrial(ctx: Context, settings: Settings, partial: Pick<Trial, "no" | "kind" | "item" | "tripletId" | "condition" | "anchorId" | "bId" | "cId" | "reason" | "prompt" | "imageBase" | "expected" | "loadBefore" | "minLoad">): Trial {
  const leftRole: "b" | "c" = ctx.rng() < 0.5 ? "b" : "c";
  const followImage = settings.labelMode === "follow_image";
  return {
    ...partial,
    leftRole,
    leftLabel: followImage ? (leftRole === "b" ? "B" : "C") : "B",
    rightLabel: followImage ? (leftRole === "b" ? "C" : "B") : "C",
  };
}

function practiceTrial(ctx: Context, settings: Settings, index: number): Trial {
  const id = PRACTICE_ITEMS[index];
  return buildImageTrial(ctx, settings, {
    no: index + 1,
    kind: "practice",
    item: -1,
    tripletId: id,
    condition: "practice",
    anchorId: `${id}_a`,
    bId: `${id}_b`,
    cId: `${id}_c`,
    reason: "fixed",
    prompt: MAIN_PROMPT,
    imageBase: `${EXTRA_ITEMS_BASE}/${id}`,
    expected: undefined,
  });
}

function attentionTrial(ctx: Context, settings: Settings, session: Session, no: number): Trial {
  const which = session.attentionPositions.indexOf(no);
  const spec = ATTENTION_ITEMS[which % ATTENTION_ITEMS.length];
  return buildImageTrial(ctx, settings, {
    no,
    kind: "attention",
    item: -1,
    tripletId: spec.id,
    condition: "attention",
    anchorId: `${spec.id}_a`,
    bId: `${spec.id}_b`,
    cId: `${spec.id}_c`,
    reason: "fixed",
    prompt: attentionPrompt(spec.expected),
    imageBase: `${EXTRA_ITEMS_BASE}/${spec.id}`,
    expected: spec.expected,
  });
}

function mainTrial(ctx: Context, settings: Settings, no: number, item: number, lease: { reason?: Trial["reason"]; loadBefore?: number; minLoad?: number }): Trial {
  const p = ctx.pool[item];
  return buildImageTrial(ctx, settings, {
    no,
    kind: "main",
    item,
    tripletId: p.id,
    condition: p.cond,
    anchorId: p.anchor,
    bId: p.b,
    cId: p.c,
    reason: lease.reason ?? "planned",
    prompt: MAIN_PROMPT,
    imageBase: `/RPLAN_triplets/${p.id}`,
    expected: undefined,
    loadBefore: lease.loadBefore,
    minLoad: lease.minLoad,
  });
}

/**
 * Counts any pending answer and moves the participant to their next question.
 * Safe to call again after a crash at any point: `lastCommit` stops double
 * counting and an existing lease for the target trial is reused.
 */
async function advanceMain(ctx: Context, pid: string): Promise<Session> {
  const settings = await getSettings(ctx);
  const session = await requireSession(ctx, pid);
  if (session.stage !== "main") return session;

  const target = session.nextTrialNo;
  const finished = target > session.total;
  const attention = !finished && session.attentionPositions.includes(target);
  const wantsLease = !finished && !attention && session.current === null;
  const pending = session.pendingCommit;
  let leased: Ledger["leases"][string] | undefined;
  let released: { pid: string; reason: string }[] = [];

  if (pending || wantsLease) {
    await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), async (ledger) => {
      released = await sweep(ctx, ledger, settings);
      leased = undefined;
      if (pending && (ledger.lastCommit[pid] ?? 0) < pending.trialNo) {
        const held = ledger.leases[pid];
        if (held && held.item === pending.item) {
          ledger.reserved[pending.item] = Math.max(0, ledger.reserved[pending.item] - 1);
          delete ledger.leases[pid];
        }
        ledger.answered[pending.item]++;
        ledger.lastCommit[pid] = pending.trialNo;
      }
      if (wantsLease) {
        const held = ledger.leases[pid];
        if (held && held.trialNo === target) {
          leased = held;
        } else {
          if (held) {
            ledger.reserved[held.item] = Math.max(0, ledger.reserved[held.item] - 1);
            delete ledger.leases[pid];
          }
          const pick = pickNext(
            ctx.pool,
            ledger,
            { seenItems: new Set(session.seenItems), seenAnchors: new Set(session.seenAnchors), plan: session.plan, tolerance: settings.balanceTolerance },
            ctx.rng,
          );
          if (pick) {
            leased = { item: pick.item, trialNo: target, leasedAt: ctx.now(), reason: pick.reason, loadBefore: pick.loadBefore, minLoad: pick.minLoad };
            ledger.leases[pid] = leased;
            ledger.reserved[pick.item]++;
            if (pick.reason !== "planned") ledger.overridesTotal++;
          }
        }
      }
      return ledger;
    });
  }
  if (released.length) await markReleased(ctx, released.filter((r) => r.pid !== pid));

  const lease = leased;
  return updateSession(ctx, pid, (s) => {
    if (s.stage !== "main") return null;
    if (s.pendingCommit && pending && s.pendingCommit.trialNo === pending.trialNo) s.pendingCommit = null;
    if (s.current) return s;
    if (finished) {
      s.stage = "post_aspects";
      return s;
    }
    if (attention) {
      s.current = attentionTrial(ctx, settings, s, target);
      return s;
    }
    if (!lease) {
      // Every question has already been shown to this participant.
      s.nextTrialNo = s.total + 1;
      s.stage = "post_aspects";
      logEvent(ctx, s, "pool_exhausted");
      return s;
    }
    const item = ctx.pool[lease.item];
    s.current = mainTrial(ctx, settings, target, lease.item, lease);
    if (!s.seenItems.includes(lease.item)) s.seenItems.push(lease.item);
    if (!s.seenAnchors.includes(item.anchor)) s.seenAnchors.push(item.anchor);
    s.plan = consumePlan(s.plan, item.cond);
    return s;
  });
}

function publicTrial(ctx: Context, session: Session, trial: Trial): PublicTrial {
  const leftFile = trial.leftRole === "b" ? "b.png" : "c.png";
  const rightFile = trial.leftRole === "b" ? "c.png" : "b.png";
  return {
    no: trial.no,
    kind: trial.kind,
    total: trial.kind === "practice" ? PRACTICE_ITEMS.length : session.total,
    answeredMain: session.responses.filter((r) => r.kind === "main" || r.kind === "attention").length,
    prompt: trial.prompt,
    subPrompts: trial.kind === "practice" ? PRACTICE_PROMPTS : undefined,
    reference: `${trial.imageBase}/a.png`,
    left: { url: `${trial.imageBase}/${leftFile}`, label: trial.leftLabel },
    right: { url: `${trial.imageBase}/${rightFile}`, label: trial.rightLabel },
    demo: ctx.demoMode
      ? {
          tripletId: trial.tripletId,
          condition: trial.condition,
          reason: trial.reason,
          anchorId: trial.anchorId,
          leftRole: trial.leftRole,
          expected: trial.expected,
          loadBefore: trial.loadBefore,
          minLoad: trial.minLoad,
        }
      : undefined,
  };
}

async function stateOf(ctx: Context, session: Session, extra: Partial<ParticipantState> = {}): Promise<ParticipantState> {
  const settings = await getSettings(ctx);
  return {
    stage: session.stage,
    status: session.status,
    pid: session.pid,
    trial: session.current ? publicTrial(ctx, session, session.current) : null,
    comprehensionAttempts: session.comprehensionAttempts,
    aspects: session.aspects,
    otherAspect: session.otherAspect,
    completionUrl: session.status === "completed" ? settings.completionUrl : undefined,
    redirectSeconds: settings.redirectSeconds,
    demoMode: ctx.demoMode,
    total: session.total,
    ...extra,
  };
}

/* -------------------------------- participant -------------------------------- */

const PID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface EnterInput {
  pid?: string | null;
  studyId?: string | null;
  sessionId?: string | null;
  source?: string | null;
}

export async function enter(ctx: Context, input: EnterInput): Promise<ParticipantState> {
  const pid = input.pid ?? "";
  if (!PID_PATTERN.test(pid)) throw new ApiError(400, "missing_params", "Valid PROLIFIC_PID is required.");
  const studyId = input.studyId && PID_PATTERN.test(input.studyId) ? input.studyId : "";
  const sessionId = input.sessionId && PID_PATTERN.test(input.sessionId) ? input.sessionId : "";
  const settings = await getSettings(ctx);
  let existing = await getSession(ctx, pid);

  if (!existing) {
    if (settings.paused) {
      return {
        stage: "consent",
        status: "in_progress",
        pid,
        trial: null,
        comprehensionAttempts: 0,
        aspects: [],
        otherAspect: "",
        redirectSeconds: settings.redirectSeconds,
        paused: true,
        demoMode: ctx.demoMode,
        total: settings.n + 2,
      };
    }
    const source: SessionSource = ctx.demoMode && (input.source === "demo" || input.source === "loadtest") ? input.source : "prolific";
    const session: Session = {
      pid,
      studyId,
      sessionIds: sessionId ? [sessionId] : [],
      phase: settings.phase,
      source,
      status: "in_progress",
      stage: "consent",
      createdAt: iso(ctx),
      updatedAt: iso(ctx),
      n: settings.n,
      total: settings.n + 2,
      attentionPositions: attentionPositions(settings.n),
      plan: conditionPlan(settings.n, ctx.rng),
      seenItems: [],
      seenAnchors: [],
      nextTrialNo: 1,
      practiceIndex: 0,
      current: null,
      pendingCommit: null,
      comprehensionAttempts: 0,
      attentionPassed: 0,
      attentionFailed: 0,
      excludedFromBalance: false,
      aspects: [],
      otherAspect: "",
      accessCount: 1,
      responses: [],
      events: [{ at: iso(ctx), type: "entered" }],
    };
    if (await ctx.store.put(sessionKey(pid), JSON.stringify(session), { ifNew: true })) return stateOf(ctx, session);
    existing = await requireSession(ctx, pid);
  }

  if (existing.status === "completed") {
    return stateOf(ctx, existing, { alreadyCompleted: true });
  }
  const wasDropped = existing.status === "dropped";
  let session = await updateSession(ctx, pid, (s) => {
    s.accessCount++;
    if (sessionId && !s.sessionIds.includes(sessionId)) s.sessionIds.push(sessionId);
    if (s.status === "dropped") s.status = "in_progress";
    if (s.status === "declined") {
      s.status = "in_progress";
      s.stage = "consent";
    }
    logEvent(ctx, s, "re_entered", wasDropped ? "after_drop" : undefined);
    return s;
  });
  if (session.status === "terminated_comprehension") return stateOf(ctx, session, { resumed: true });
  if (session.stage === "main") session = await resumeMain(ctx, session);
  return stateOf(ctx, session, { resumed: true });
}

/** On return: keep the open question if its lease survived, otherwise hand out a fresh one. */
async function resumeMain(ctx: Context, session: Session): Promise<Session> {
  const pid = session.pid;
  const current = session.current;
  let stillHeld = current?.kind !== "main";
  if (current?.kind === "main") {
    const ledger = await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), (l) => {
      const lease = l.leases[pid];
      if (!lease || lease.leavingAt === undefined) return null;
      delete lease.leavingAt;
      return l;
    });
    stillHeld = ledger.leases[pid]?.item === current.item;
    if (!stillHeld) {
      await updateSession(ctx, pid, (s) => {
        if (s.current?.no !== current.no) return null;
        s.plan = [current.condition as Condition, ...s.plan];
        s.current = null;
        logEvent(ctx, s, "question_reassigned", current.tripletId);
        return s;
      });
    }
  }
  return advanceMain(ctx, pid);
}

export interface AnswerInput {
  pid: string;
  trialNo: number;
  kind: string;
  value: ResponseValue;
  rtMs: number;
  imagesShownAt?: string;
  zoomCount?: number;
  sessionId?: string;
  autofilled?: boolean;
}

const VALID_RESPONSES: ResponseValue[] = ["B", "C", "equal", "cannot_judge"];

export async function answer(ctx: Context, input: AnswerInput): Promise<ParticipantState> {
  if (!VALID_RESPONSES.includes(input.value)) throw new ApiError(400, "invalid_response");
  const settings = await getSettings(ctx);
  let duplicate = false;
  const saved = await updateSession(ctx, input.pid, (s) => {
    const trial = s.current;
    if (!trial || trial.no !== input.trialNo || trial.kind !== input.kind) {
      duplicate = true;
      return null;
    }
    if (s.status === "completed") {
      duplicate = true;
      return null;
    }
    const leftId = trial.leftRole === "b" ? trial.bId : trial.cId;
    const rightId = trial.leftRole === "b" ? trial.cId : trial.bId;
    const correct = trial.kind === "attention" ? input.value === trial.expected : undefined;
    const selectedImageId = input.value === trial.leftLabel ? leftId : input.value === trial.rightLabel ? rightId : undefined;
    const screenId = trial.kind === "practice" ? "S06_practice" : trial.kind === "attention" ? "S10_attention" : "S07_main";
    const row: ResponseRow = {
      screenId,
      questionId: trial.kind === "main" ? trial.tripletId : `${trial.kind}_${trial.no}`,
      sessionId: input.sessionId ?? s.sessionIds[s.sessionIds.length - 1] ?? "",
      kind: trial.kind,
      trialNo: trial.no,
      tripletId: trial.tripletId,
      condition: trial.condition,
      anchorId: trial.anchorId,
      bId: trial.bId,
      cId: trial.cId,
      leftImageId: leftId,
      rightImageId: rightId,
      leftLabel: trial.leftLabel,
      rightLabel: trial.rightLabel,
      value: input.value,
      selectedImageId,
      correct,
      rtMs: Math.max(0, Math.round(Number(input.rtMs) || 0)),
      imagesShownAt: input.imagesShownAt,
      answeredAt: iso(ctx),
      zoomCount: input.zoomCount ?? 0,
      assignmentReason: trial.reason,
      autofilled: input.autofilled || undefined,
    };
    if (s.status === "dropped") {
      row.lateAfterRelease = true;
      s.status = "in_progress";
    }
    s.responses.push(row);
    if (trial.kind === "attention") {
      if (correct) s.attentionPassed++;
      else s.attentionFailed++;
    }
    s.current = null;
    if (trial.kind === "practice") {
      s.practiceIndex++;
      if (s.practiceIndex < PRACTICE_ITEMS.length) s.current = practiceTrial(ctx, settings, s.practiceIndex);
      else s.stage = "main";
    } else {
      s.nextTrialNo = trial.no + 1;
      if (trial.kind === "main") s.pendingCommit = { item: trial.item, trialNo: trial.no };
    }
    return s;
  });
  let session = saved;
  if (session.stage === "main" && (session.current === null || session.pendingCommit)) {
    session = await advanceMain(ctx, input.pid);
  }
  return stateOf(ctx, session, duplicate ? { duplicate: true } : {});
}

function appendRow(ctx: Context, s: Session, row: Omit<ResponseRow, "sessionId" | "answeredAt">) {
  s.responses.push({ ...row, sessionId: s.sessionIds[s.sessionIds.length - 1] ?? "", answeredAt: iso(ctx) });
}

export async function submitStage(ctx: Context, pid: string, stage: Stage, payload: Record<string, unknown>): Promise<ParticipantState> {
  const settings = await getSettings(ctx);
  const validateOne = (value: unknown, allowed: string[]) => {
    if (typeof value !== "string" || !allowed.includes(value)) throw new ApiError(400, "invalid_response");
    return value;
  };
  let completedNow = false;
  const text = (value: unknown, limit = 4000) => (typeof value === "string" ? value.slice(0, limit) : "");

  let session = await updateSession(ctx, pid, (s) => {
    if (s.stage !== stage) return null;
    switch (stage) {
      case "consent": {
        const agreed = payload.agree === true;
        appendRow(ctx, s, { screenId: "S01_consent", questionId: "consent", kind: "consent", value: agreed ? "agree" : "decline" });
        if (agreed) s.stage = "instructions";
        else {
          s.stage = "ended_declined";
          s.status = "declined";
        }
        break;
      }
      case "instructions":
        s.stage = "comprehension";
        break;
      case "comprehension": {
        const value = validateOne(payload.value, COMPREHENSION.options.map((o) => o.value));
        s.comprehensionAttempts++;
        const correct = value === COMPREHENSION.correct;
        appendRow(ctx, s, {
          screenId: s.comprehensionAttempts === 1 ? "S03_comprehension" : "S04_comprehension_retry",
          questionId: `${COMPREHENSION.questionId}_attempt${s.comprehensionAttempts}`,
          kind: "comprehension",
          value,
          correct,
        });
        if (correct) {
          s.stage = "practice";
          s.current = practiceTrial(ctx, settings, 0);
        } else if (s.comprehensionAttempts >= 2) {
          s.stage = "ended_comprehension";
          s.status = "terminated_comprehension";
        }
        break;
      }
      case "post_aspects": {
        const allowed = ASPECTS.map((a) => a.value);
        const values = Array.isArray(payload.values) ? payload.values.map((v) => validateOne(v, allowed)) : [];
        if (values.length === 0) throw new ApiError(400, "invalid_response", "Select at least one.");
        const other = values.includes("other") ? text(payload.other, 500).trim() : "";
        if (values.includes("other") && !other) throw new ApiError(400, "invalid_response", "Please describe “Other”.");
        s.aspects = values;
        s.otherAspect = other;
        appendRow(ctx, s, { screenId: "S18_aspects", questionId: "aspects_considered", kind: "post", value: values.join("|"), text: other || undefined });
        s.stage = "post_most";
        break;
      }
      case "post_most": {
        const value = validateOne(payload.value, s.aspects);
        const other = value === "other" ? text(payload.other, 500).trim() || s.otherAspect : "";
        appendRow(ctx, s, { screenId: "S19_most_important", questionId: "most_important_aspect", kind: "post", value, text: other || undefined });
        s.stage = "post_difficulty";
        break;
      }
      case "post_difficulty": {
        const value = validateOne(payload.value, DIFFICULTY.map((d) => d.value));
        appendRow(ctx, s, { screenId: "S20_difficulty", questionId: "overall_difficulty", kind: "post", value });
        s.stage = "post_comments";
        break;
      }
      case "post_comments": {
        const comment = text(payload.text).trim();
        appendRow(ctx, s, { screenId: "S21_comments", questionId: "additional_comments", kind: "post", value: comment ? "provided" : "blank", text: comment || undefined });
        s.stage = "demographics";
        break;
      }
      case "demographics": {
        const answers = (payload.answers ?? {}) as Record<string, unknown>;
        const validated = DEMOGRAPHICS.map((q) => ({ id: q.id, value: validateOne(answers[q.id], q.options) }));
        for (const a of validated) appendRow(ctx, s, { screenId: "S22_demographics", questionId: a.id, kind: "demographic", value: a.value });
        s.stage = "complete";
        s.status = "completed";
        s.completedAt = iso(ctx);
        logEvent(ctx, s, "completed");
        completedNow = true;
        break;
      }
      default:
        throw new ApiError(409, "wrong_stage");
    }
    return s;
  });

  if (session.stage === "main") session = await advanceMain(ctx, pid);
  if (completedNow && settings.excludeFailedAttention && session.attentionFailed > 0) {
    session = await excludeFromBalance(ctx, session);
  }
  return stateOf(ctx, session);
}

async function excludeFromBalance(ctx: Context, session: Session): Promise<Session> {
  const items = session.responses.filter((r) => r.kind === "main" && r.tripletId);
  const index = poolIndex(ctx);
  await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), (ledger) => {
    for (const row of items) {
      const i = index.get(row.tripletId!);
      if (i !== undefined) ledger.answered[i] = Math.max(0, ledger.answered[i] - 1);
    }
    return ledger;
  });
  return updateSession(ctx, session.pid, (s) => {
    s.excludedFromBalance = true;
    logEvent(ctx, s, "excluded_from_balance", "attention_failed");
    return s;
  });
}

let cachedIndex: { pool: PoolItem[]; index: Map<string, number> } | null = null;
function poolIndex(ctx: Context): Map<string, number> {
  if (cachedIndex?.pool !== ctx.pool) cachedIndex = { pool: ctx.pool, index: new Map(ctx.pool.map((p, i) => [p.id, i])) };
  return cachedIndex.index;
}

export async function heartbeat(ctx: Context, pid: string): Promise<{ ok: true }> {
  await ctx.store.put(beatKey(pid), JSON.stringify({ at: ctx.now() }));
  return { ok: true };
}

/**
 * "back" is an explicit dropout: the question goes back immediately.
 * "pagehide" also fires on reload, so it starts a short grace period instead.
 */
export async function leave(ctx: Context, pid: string, reason: string): Promise<{ ok: true }> {
  const session = await getSession(ctx, pid);
  if (!session || session.status !== "in_progress") return { ok: true };
  if (reason === "back") {
    await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), (ledger) => {
      const lease = ledger.leases[pid];
      if (!lease) return null;
      ledger.reserved[lease.item] = Math.max(0, ledger.reserved[lease.item] - 1);
      delete ledger.leases[pid];
      ledger.releasedTotal++;
      return ledger;
    });
    await updateSession(ctx, pid, (s) => {
      if (s.status !== "in_progress") return null;
      s.status = "dropped";
      logEvent(ctx, s, "dropped", "browser_back");
      return s;
    });
    return { ok: true };
  }
  await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), (ledger) => {
    const lease = ledger.leases[pid];
    if (!lease) return null;
    lease.leavingAt = ctx.now();
    return ledger;
  });
  return { ok: true };
}

export interface ImageErrorInput {
  pid: string;
  trialNo: number;
  url: string;
  simulated?: boolean;
}

/** The participant gets a different question straight away; the report goes to the admin screen. */
export async function reportImageError(ctx: Context, input: ImageErrorInput): Promise<ParticipantState> {
  const settings = await getSettings(ctx);
  const session = await requireSession(ctx, input.pid);
  const trial = session.current;
  const simulated = Boolean(input.simulated && ctx.demoMode);
  if (!trial || trial.no !== input.trialNo) return stateOf(ctx, session);

  await transact<ImageErrorRecord[]>(ctx, KEY_ERRORS, () => [], (records) => {
    records.push({ at: iso(ctx), pid: input.pid, tripletId: trial.tripletId, url: String(input.url).slice(0, 300), kind: trial.kind, simulated });
    return records.slice(-500);
  });
  if (trial.kind !== "main") return stateOf(ctx, session);

  await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), (ledger) => {
    const lease = ledger.leases[input.pid];
    if (lease?.item === trial.item) {
      ledger.reserved[trial.item] = Math.max(0, ledger.reserved[trial.item] - 1);
      delete ledger.leases[input.pid];
    }
    if (!simulated) {
      ledger.errorReports[trial.item]++;
      if (ledger.errorReports[trial.item] >= settings.imageErrorBlockThreshold && !ledger.blocked.includes(trial.item)) ledger.blocked.push(trial.item);
    }
    return ledger;
  });
  await updateSession(ctx, input.pid, (s) => {
    if (s.current?.no !== trial.no) return null;
    s.plan = [trial.condition as Condition, ...s.plan];
    s.current = null;
    logEvent(ctx, s, "image_error_replaced", trial.tripletId);
    return s;
  });
  return stateOf(ctx, await advanceMain(ctx, input.pid), { resumed: false });
}

/* ------------------------------------ admin ----------------------------------- */

export async function allSessions(ctx: Context): Promise<Session[]> {
  const keys = await ctx.store.list(PREFIX_SESSION);
  const sessions = await mapLimit(keys, READ_CONCURRENCY, (key) => readJson<Session>(ctx, key));
  return sessions.filter((s): s is Session => s !== null);
}

/** A participant silent past the idle limit is reported as dropped, whichever screen they stopped on. */
function effectiveStatus(ctx: Context, settings: Settings, s: Session): SessionStatus {
  if (s.status === "in_progress" && ctx.now() - Date.parse(s.updatedAt) > settings.idleTimeoutSec * 1000) return "dropped";
  return s.status;
}

const FUNNEL: { stage: string; label: string; reached: (s: Session) => boolean }[] = [
  { stage: "entered", label: "アクセス", reached: () => true },
  { stage: "consented", label: "同意", reached: (s) => s.responses.some((r) => r.screenId === "S01_consent" && r.value === "agree") },
  { stage: "comprehension", label: "理解度確認 合格", reached: (s) => s.responses.some((r) => r.kind === "comprehension" && r.correct) },
  { stage: "practice", label: "練習 完了", reached: (s) => s.practiceIndex >= PRACTICE_ITEMS.length },
  { stage: "main", label: "本試行 完了", reached: (s) => s.nextTrialNo > s.total },
  { stage: "completed", label: "全工程 完了", reached: (s) => s.status === "completed" },
];

export async function adminSummary(ctx: Context): Promise<AdminSummary> {
  const settings = await getSettings(ctx);
  let released: { pid: string; reason: string }[] = [];
  const ledger = await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), async (l) => {
    released = await sweep(ctx, l, settings);
    return released.length ? l : null;
  });
  if (released.length) await markReleased(ctx, released);
  const sessions = await allSessions(ctx);
  const errors = (await readJson<ImageErrorRecord[]>(ctx, KEY_ERRORS)) ?? [];

  const status = sessions.map((s) => effectiveStatus(ctx, settings, s));
  const count = (wanted: SessionStatus) => status.filter((value) => value === wanted).length;
  const bySource: Record<string, number> = {};
  for (const s of sessions) bySource[s.source] = (bySource[s.source] ?? 0) + 1;
  const rows = sessions.flatMap((s) => s.responses);
  const stats = balanceStats(ledger.answered);
  const totalWeight = CONDITIONS.reduce((sum, c) => sum + CONDITION_WEIGHTS[c], 0);
  const totalAnswered = ledger.answered.reduce((sum, value) => sum + value, 0);

  const conditions = CONDITIONS.map((condition) => {
    const indexes = ctx.pool.flatMap((p, i) => (p.cond === condition ? [i] : []));
    const counts = indexes.map((i) => ledger.answered[i]);
    const answered = counts.reduce((sum, value) => sum + value, 0);
    return {
      condition,
      items: indexes.length,
      answered,
      targetShare: CONDITION_WEIGHTS[condition] / totalWeight,
      actualShare: totalAnswered ? answered / totalAnswered : 0,
      minAnswered: counts.length ? Math.min(...counts) : 0,
      maxAnswered: counts.length ? Math.max(...counts) : 0,
    };
  });

  const summaries: SessionSummary[] = sessions
    .map((s, i) => ({
      pid: s.pid,
      studyId: s.studyId,
      sessionId: s.sessionIds[s.sessionIds.length - 1] ?? "",
      source: s.source,
      phase: s.phase,
      status: status[i],
      stage: s.stage,
      mainAnswered: s.responses.filter((r) => r.kind === "main").length,
      n: s.n,
      attentionPassed: s.attentionPassed,
      attentionFailed: s.attentionFailed,
      accessCount: s.accessCount,
      updatedAt: s.updatedAt,
    }))
    .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));

  return {
    settings,
    poolSize: ctx.pool.length,
    images: ctx.pool.length * 3,
    participants: {
      total: sessions.length,
      active: count("in_progress"),
      completed: count("completed"),
      dropped: count("dropped"),
      terminated: count("terminated_comprehension"),
      declined: count("declined"),
      bySource,
      attentionFailed: sessions.filter((s) => s.attentionFailed > 0).length,
    },
    funnel: FUNNEL.map((f) => ({ stage: f.stage, label: f.label, count: sessions.filter(f.reached).length })),
    responses: {
      main: rows.filter((r) => r.kind === "main").length,
      attention: rows.filter((r) => r.kind === "attention").length,
      practice: rows.filter((r) => r.kind === "practice").length,
      survey: rows.filter((r) => r.kind === "post" || r.kind === "demographic" || r.kind === "comprehension" || r.kind === "consent").length,
      total: rows.length,
    },
    balance: {
      ...stats,
      reserved: ledger.reserved.reduce((sum, value) => sum + value, 0),
      blocked: ledger.blocked.length,
      histogram: histogram(ledger.answered),
      overrides: ledger.overridesTotal,
      releases: ledger.releasedTotal,
    },
    conditions,
    sessions: summaries.slice(0, 200),
    imageErrors: errors.slice(-100).reverse(),
    importReport: ctx.importReport,
    defectReport: ctx.defectReport,
    now: iso(ctx),
    demoMode: ctx.demoMode,
    releasedNow: released.length,
  };
}

export async function itemRows(ctx: Context): Promise<ItemRow[]> {
  const ledger = (await readJson<Ledger>(ctx, KEY_LEDGER)) ?? blankLedger(ctx);
  const blocked = new Set(ledger.blocked);
  return ctx.pool.map((p, i) => ({
    index: i,
    id: p.id,
    condition: p.cond,
    anchorId: p.anchor,
    answered: ledger.answered[i],
    reserved: ledger.reserved[i],
    errorReports: ledger.errorReports[i],
    blocked: blocked.has(i),
  }));
}

export async function setBlocked(ctx: Context, tripletId: string, value: boolean) {
  const index = poolIndex(ctx).get(tripletId);
  if (index === undefined) throw new ApiError(404, "unknown_triplet");
  await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), (ledger) => {
    ledger.blocked = ledger.blocked.filter((i) => i !== index);
    if (value) ledger.blocked.push(index);
    else ledger.errorReports[index] = 0;
    return ledger;
  });
  return { ok: true };
}

const EDITABLE: (keyof Settings)[] = [
  "n",
  "completionUrl",
  "paused",
  "phase",
  "labelMode",
  "balanceTolerance",
  "heartbeatTimeoutSec",
  "idleTimeoutSec",
  "leaveGraceSec",
  "redirectSeconds",
  "excludeFailedAttention",
  "imageErrorBlockThreshold",
];

export async function updateSettings(ctx: Context, patch: Partial<Settings>): Promise<Settings> {
  const clean: Partial<Settings> = {};
  for (const key of EDITABLE) if (patch[key] !== undefined) (clean as Record<string, unknown>)[key] = patch[key];

  if (clean.n !== undefined) {
    const n = Number(clean.n);
    if (!Number.isInteger(n) || n < 1 || n > ctx.pool.length) throw new ApiError(400, "invalid_n", `N must be between 1 and ${ctx.pool.length}.`);
    const current = await getSettings(ctx);
    if (n !== current.n && (await ctx.store.list(PREFIX_SESSION)).length > 0) {
      throw new ApiError(409, "study_started", "参加者データがあるため N は変更できません。リセット後に変更してください。");
    }
    clean.n = n;
  }
  if (clean.completionUrl !== undefined) {
    const url = String(clean.completionUrl).trim();
    if (!/^https?:\/\/\S+$/i.test(url) && !/^\/[^/\s]\S*$/.test(url)) throw new ApiError(400, "invalid_url", "完了URLは http(s):// で始まる形式で入力してください。");
    clean.completionUrl = url;
  }
  for (const key of ["balanceTolerance", "heartbeatTimeoutSec", "idleTimeoutSec", "leaveGraceSec", "redirectSeconds", "imageErrorBlockThreshold"] as const) {
    if (clean[key] !== undefined) {
      const value = Number(clean[key]);
      if (!Number.isFinite(value) || value < 0 || value > 86400) throw new ApiError(400, "invalid_setting", key);
      clean[key] = value;
    }
  }
  if (clean.phase !== undefined && clean.phase !== "pilot" && clean.phase !== "main") throw new ApiError(400, "invalid_setting", "phase");
  if (clean.labelMode !== undefined && clean.labelMode !== "follow_image" && clean.labelMode !== "fixed_position") throw new ApiError(400, "invalid_setting", "labelMode");
  return transact<Settings>(ctx, KEY_SETTINGS, () => defaultSettings(ctx.now(), ctx.demoMode), (s) => ({ ...s, ...clean, updatedAt: iso(ctx) }));
}

export async function exportCsv(ctx: Context, type: string, excludeTest: boolean): Promise<string> {
  if (type === "items") return itemsCsv(await itemRows(ctx));
  const settings = await getSettings(ctx);
  const sessions = (await allSessions(ctx))
    .filter((s) => !excludeTest || s.source === "prolific")
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
    .map((s) => ({ ...s, status: effectiveStatus(ctx, settings, s) }));
  if (type === "participants") return participantsCsv(sessions);
  if (type === "responses") return responsesCsv(sessions);
  throw new ApiError(400, "unknown_export");
}

/** Recounts the ledger from the saved answers. They must always agree. */
export async function reconcile(ctx: Context, fix: boolean) {
  const sessions = await allSessions(ctx);
  const index = poolIndex(ctx);
  const recount = new Array(ctx.pool.length).fill(0);
  for (const s of sessions) {
    if (s.excludedFromBalance) continue;
    for (const row of s.responses) {
      if (row.kind !== "main") continue;
      const i = index.get(row.tripletId ?? "");
      if (i !== undefined) recount[i]++;
    }
  }
  const ledger = (await readJson<Ledger>(ctx, KEY_LEDGER)) ?? blankLedger(ctx);
  const mismatches = recount.flatMap((value, i) => (value === ledger.answered[i] ? [] : [{ tripletId: ctx.pool[i].id, saved: value, ledger: ledger.answered[i] }]));
  if (fix && mismatches.length) {
    await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), (l) => {
      l.answered = recount;
      return l;
    });
  }
  return {
    savedResponses: recount.reduce((sum, value) => sum + value, 0),
    ledgerResponses: ledger.answered.reduce((sum, value) => sum + value, 0),
    mismatchedItems: mismatches.length,
    samples: mismatches.slice(0, 20),
    duplicateAssignments: sessions.filter((s) => {
      const ids = s.responses.filter((r) => r.kind === "main").map((r) => r.tripletId);
      return new Set(ids).size !== ids.length;
    }).length,
    fixed: fix && mismatches.length > 0,
  };
}

export async function resetAll(ctx: Context) {
  const keys = [...(await ctx.store.list(PREFIX_SESSION)), ...(await ctx.store.list(PREFIX_BEAT))];
  await mapLimit(keys, READ_CONCURRENCY, (key) => ctx.store.remove(key));
  await ctx.store.remove(KEY_LEDGER);
  await ctx.store.remove(KEY_ERRORS);
  return { removed: keys.length };
}

/**
 * Fills the study with simulated participants so the dashboard has data to show.
 * They run through the real allocator and are labelled `simulated` in every export.
 */
export async function seedSimulated(ctx: Context, count: number) {
  const limited = Math.max(1, Math.min(60, Math.floor(count)));
  const settings = await getSettings(ctx);
  const batch = `${ctx.now().toString(36)}`;
  let sessions: Session[] = [];
  await transact<Ledger>(ctx, KEY_LEDGER, () => blankLedger(ctx), (ledger) => {
    sessions = [];
    for (let k = 0; k < limited; k++) {
      sessions.push(simulateOne(ctx, settings, ledger, `SIM_${batch}_${String(k + 1).padStart(2, "0")}`));
    }
    return ledger;
  });
  await mapLimit(sessions, READ_CONCURRENCY, (s) => ctx.store.put(sessionKey(s.pid), JSON.stringify(s)));
  return { created: sessions.length };
}

function simulateOne(ctx: Context, settings: Settings, ledger: Ledger, pid: string): Session {
  const rng = ctx.rng;
  const pickOne = <T,>(values: readonly T[]) => values[Math.floor(rng() * values.length)];
  const startedAt = ctx.now() - Math.floor(rng() * 3_600_000) - 1_800_000;
  const stamp = (offset: number) => new Date(startedAt + offset).toISOString();
  const sessionId = `SIMSESSION_${pid}`;
  const positions = attentionPositions(settings.n);
  const total = settings.n + 2;
  const dropsAt = rng() < 0.15 ? 1 + Math.floor(rng() * (total - 1)) : Infinity;
  const responses: ResponseRow[] = [];
  let plan = conditionPlan(settings.n, rng);
  const seenItems: number[] = [];
  const seenAnchors: string[] = [];
  let attentionPassed = 0;
  let attentionFailed = 0;
  let clock = 20_000;
  let next = 1;
  const base = { sessionId };
  responses.push({ ...base, screenId: "S01_consent", questionId: "consent", kind: "consent", value: "agree", answeredAt: stamp(clock) });
  clock += 25_000;
  responses.push({ ...base, screenId: "S03_comprehension", questionId: "comprehension_task_attempt1", kind: "comprehension", value: COMPREHENSION.correct, correct: true, answeredAt: stamp(clock) });

  for (; next <= total && next < dropsAt; next++) {
    const rt = 2500 + Math.floor(rng() * 9000);
    clock += rt;
    const isAttention = positions.includes(next);
    let trial: Trial;
    if (isAttention) {
      trial = { ...buildImageTrial(ctx, settings, { no: next, kind: "attention", item: -1, tripletId: ATTENTION_ITEMS[positions.indexOf(next)].id, condition: "attention", anchorId: "attention_a", bId: "attention_b", cId: "attention_c", reason: "fixed", prompt: "", imageBase: "", expected: ATTENTION_ITEMS[positions.indexOf(next)].expected, loadBefore: undefined, minLoad: undefined }) };
    } else {
      const pick = pickNext(ctx.pool, ledger, { seenItems: new Set(seenItems), seenAnchors: new Set(seenAnchors), plan, tolerance: settings.balanceTolerance }, rng);
      if (!pick) break;
      const item = ctx.pool[pick.item];
      if (pick.reason !== "planned") ledger.overridesTotal++;
      ledger.answered[pick.item]++;
      seenItems.push(pick.item);
      seenAnchors.push(item.anchor);
      plan = consumePlan(plan, item.cond);
      trial = mainTrial(ctx, settings, next, pick.item, { reason: pick.reason, loadBefore: pick.loadBefore, minLoad: pick.minLoad });
    }
    const leftId = trial.leftRole === "b" ? trial.bId : trial.cId;
    const rightId = trial.leftRole === "b" ? trial.cId : trial.bId;
    let value: ResponseValue;
    if (isAttention) {
      const passes = rng() < 0.95;
      value = passes ? trial.expected! : trial.expected === "B" ? "C" : "B";
      if (passes) attentionPassed++;
      else attentionFailed++;
    } else {
      const roll = rng();
      value = roll < 0.43 ? "B" : roll < 0.86 ? "C" : roll < 0.96 ? "equal" : "cannot_judge";
    }
    responses.push({
      ...base,
      screenId: isAttention ? "S10_attention" : "S07_main",
      questionId: isAttention ? `attention_${next}` : trial.tripletId,
      kind: isAttention ? "attention" : "main",
      trialNo: next,
      tripletId: trial.tripletId,
      condition: trial.condition,
      anchorId: trial.anchorId,
      bId: trial.bId,
      cId: trial.cId,
      leftImageId: leftId,
      rightImageId: rightId,
      leftLabel: trial.leftLabel,
      rightLabel: trial.rightLabel,
      value,
      selectedImageId: value === trial.leftLabel ? leftId : value === trial.rightLabel ? rightId : undefined,
      correct: isAttention ? value === trial.expected : undefined,
      rtMs: rt,
      imagesShownAt: stamp(clock - rt),
      answeredAt: stamp(clock),
      zoomCount: rng() < 0.1 ? 1 : 0,
      assignmentReason: trial.reason,
    });
  }

  const completed = next > total;
  if (completed) {
    clock += 40_000;
    responses.push({ ...base, screenId: "S18_aspects", questionId: "aspects_considered", kind: "post", value: "room_arrangement|overall_shape", answeredAt: stamp(clock) });
    responses.push({ ...base, screenId: "S19_most_important", questionId: "most_important_aspect", kind: "post", value: "room_arrangement", answeredAt: stamp(clock + 8000) });
    responses.push({ ...base, screenId: "S20_difficulty", questionId: "overall_difficulty", kind: "post", value: pickOne(DIFFICULTY).value, answeredAt: stamp(clock + 14000) });
    responses.push({ ...base, screenId: "S21_comments", questionId: "additional_comments", kind: "post", value: "blank", answeredAt: stamp(clock + 20000) });
    for (const q of DEMOGRAPHICS) responses.push({ ...base, screenId: "S22_demographics", questionId: q.id, kind: "demographic", value: pickOne(q.options), answeredAt: stamp(clock + 45000) });
    clock += 45_000;
  }
  const session: Session = {
    pid,
    studyId: "SIMULATED_STUDY",
    sessionIds: [sessionId],
    phase: settings.phase,
    source: "simulated",
    status: completed ? "completed" : "dropped",
    stage: completed ? "complete" : "main",
    createdAt: stamp(0),
    updatedAt: stamp(clock),
    completedAt: completed ? stamp(clock) : undefined,
    n: settings.n,
    total,
    attentionPositions: positions,
    plan,
    seenItems,
    seenAnchors,
    nextTrialNo: next,
    practiceIndex: PRACTICE_ITEMS.length,
    current: null,
    pendingCommit: null,
    comprehensionAttempts: 1,
    attentionPassed,
    attentionFailed,
    excludedFromBalance: false,
    aspects: [],
    otherAspect: "",
    accessCount: 1,
    responses,
    events: [{ at: stamp(0), type: "simulated" }],
  };
  return session;
}

