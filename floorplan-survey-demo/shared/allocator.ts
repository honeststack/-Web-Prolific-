/**
 * Pure assignment logic. It has no I/O so the same code runs in the API,
 * in the tests, and in the browser simulator on the admin screen.
 */
import { AssignmentReason, CONDITIONS, CONDITION_WEIGHTS, Condition, Ledger, PoolItem } from "./types";

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(values: readonly T[], rng: Rng): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Largest-remainder rounding, so any N stays as close as possible to 2:1:1:2:1:1:2. */
export function conditionQuota(n: number): Record<Condition, number> {
  const totalWeight = CONDITIONS.reduce((sum, c) => sum + CONDITION_WEIGHTS[c], 0);
  const exact = CONDITIONS.map((c) => ({ c, value: (n * CONDITION_WEIGHTS[c]) / totalWeight }));
  const quota = Object.fromEntries(exact.map((e) => [e.c, Math.floor(e.value)])) as Record<Condition, number>;
  let left = n - exact.reduce((sum, e) => sum + Math.floor(e.value), 0);
  const order = [...exact].sort(
    (x, y) =>
      y.value - Math.floor(y.value) - (x.value - Math.floor(x.value)) ||
      CONDITION_WEIGHTS[y.c] - CONDITION_WEIGHTS[x.c] ||
      CONDITIONS.indexOf(x.c) - CONDITIONS.indexOf(y.c),
  );
  for (const e of order) {
    if (left-- <= 0) break;
    quota[e.c]++;
  }
  return quota;
}

export function conditionPlan(n: number, rng: Rng): Condition[] {
  const quota = conditionQuota(n);
  return shuffle(
    CONDITIONS.flatMap((c) => Array.from({ length: quota[c] }, () => c)),
    rng,
  );
}

/**
 * Attention checks sit at the same relative points as the agreed 42-question
 * flow (questions 16 and 31), and scale with N.
 */
export function attentionPositions(n: number): number[] {
  const total = n + 2;
  const first = Math.max(2, Math.round((total * 16) / 42));
  const second = Math.max(first + 1, Math.min(total, Math.round((total * 31) / 42)));
  return [first, second];
}

export function emptyLedger(size: number): Ledger {
  return {
    answered: new Array(size).fill(0),
    reserved: new Array(size).fill(0),
    errorReports: new Array(size).fill(0),
    blocked: [],
    leases: {},
    lastCommit: {},
    releasedTotal: 0,
    overridesTotal: 0,
  };
}

interface PoolIndex {
  conds: Uint8Array;
  anchors: Int32Array;
  anchorIds: Map<string, number>;
  anchorCount: number;
}

const poolIndexes = new WeakMap<readonly PoolItem[], PoolIndex>();

/** Integer view of the pool, built once, so a pick stays fast at 3,000 questions. */
function indexOf(pool: readonly PoolItem[]): PoolIndex {
  let index = poolIndexes.get(pool);
  if (!index) {
    const anchorIds = new Map<string, number>();
    const anchors = new Int32Array(pool.length);
    const conds = new Uint8Array(pool.length);
    pool.forEach((item, i) => {
      if (!anchorIds.has(item.anchor)) anchorIds.set(item.anchor, anchorIds.size);
      anchors[i] = anchorIds.get(item.anchor)!;
      conds[i] = CONDITIONS.indexOf(item.cond);
    });
    index = { conds, anchors, anchorIds, anchorCount: anchorIds.size };
    poolIndexes.set(pool, index);
  }
  return index;
}

export interface PickContext {
  seenItems: ReadonlySet<number>;
  seenAnchors: ReadonlySet<string>;
  plan: readonly Condition[];
  tolerance: number;
}

export interface PickResult {
  item: number;
  reason: AssignmentReason;
  condition: Condition;
  loadBefore: number;
  minLoad: number;
}

/**
 * Chooses the next question for one participant.
 *
 * "Load" is answers saved plus questions currently open, so a question someone
 * is looking at already counts. The order of preference encodes the priorities
 * in the brief:
 *   1. the planned condition, new anchor, within `tolerance` of the lowest load
 *   2. any condition, new anchor, within tolerance (balance beats the ratio)
 *   3. any condition, repeated anchor, within tolerance ("avoid where possible")
 *   4. the lowest load left (no duplicate question, ever)
 */
export function pickNext(pool: readonly PoolItem[], ledger: Ledger, ctx: PickContext, rng: Rng): PickResult | null {
  const index = indexOf(pool);
  const { answered, reserved } = ledger;
  const skipItem = new Uint8Array(pool.length);
  for (const i of ctx.seenItems) skipItem[i] = 1;
  for (const i of ledger.blocked) skipItem[i] = 1;
  const repeated = new Uint8Array(index.anchorCount);
  for (const anchor of ctx.seenAnchors) {
    const id = index.anchorIds.get(anchor);
    if (id !== undefined) repeated[id] = 1;
  }
  const planned = CONDITIONS.indexOf(ctx.plan[0]);
  const due = new Uint8Array(CONDITIONS.length);
  for (const condition of ctx.plan) due[CONDITIONS.indexOf(condition)] = 1;

  // Which tiers a question belongs to, as bits.
  const PLANNED_NEW = 0; // planned condition, new anchor
  const DUE_NEW = 1; // a condition still due, new anchor
  const ANY_NEW = 2; // any condition, new anchor
  const PLANNED_ANY = 3; // planned condition, repeated anchor allowed
  const ANY = 4; // anything not yet seen
  const tiersOf = (i: number): number => {
    const isPlanned = index.conds[i] === planned;
    let bits = 1 << ANY;
    if (isPlanned) bits |= 1 << PLANNED_ANY;
    if (!repeated[index.anchors[i]]) {
      bits |= 1 << ANY_NEW;
      if (due[index.conds[i]]) bits |= 1 << DUE_NEW;
      if (isPlanned) bits |= 1 << PLANNED_NEW;
    }
    return bits;
  };

  // First pass finds the lowest load and its tie count in every tier.
  const best = [Infinity, Infinity, Infinity, Infinity, Infinity];
  const ties = [0, 0, 0, 0, 0];
  for (let i = 0; i < pool.length; i++) {
    if (skipItem[i]) continue;
    const load = answered[i] + reserved[i];
    const bits = tiersOf(i);
    for (let tier = 0; tier < 5; tier++) {
      if (!(bits & (1 << tier))) continue;
      if (load < best[tier]) {
        best[tier] = load;
        ties[tier] = 1;
      } else if (load === best[tier]) {
        ties[tier]++;
      }
    }
  }
  const minLoad = best[ANY];
  if (minLoad === Infinity) return null;

  const ceiling = minLoad + ctx.tolerance;
  let tier: number;
  let reason: AssignmentReason;
  if (best[PLANNED_NEW] <= ceiling) [tier, reason] = [PLANNED_NEW, "planned"];
  else if (best[DUE_NEW] <= ceiling) [tier, reason] = [DUE_NEW, "balance_override"]; // keeps the ratio as close as it can
  else if (best[ANY_NEW] <= ceiling) [tier, reason] = [ANY_NEW, "balance_override"];
  else if (best[PLANNED_ANY] <= ceiling) [tier, reason] = [PLANNED_ANY, "anchor_relaxed"];
  else [tier, reason] = [ANY, best[ANY] <= ceiling ? "anchor_relaxed" : "last_resort"];

  // Second pass takes a uniformly random one of the ties, so position never favours a question.
  let skip = Math.floor(rng() * ties[tier]);
  for (let i = 0; i < pool.length; i++) {
    if (skipItem[i] || answered[i] + reserved[i] !== best[tier] || !(tiersOf(i) & (1 << tier))) continue;
    if (skip-- === 0) return { item: i, reason, condition: pool[i].cond, loadBefore: best[tier], minLoad };
  }
  return null;
}

/** Takes the chosen condition out of the plan; an override uses that condition's slot if one is left. */
export function consumePlan(plan: readonly Condition[], chosen: Condition): Condition[] {
  const next = [...plan];
  const at = next.indexOf(chosen);
  next.splice(at >= 0 ? at : 0, 1);
  return next;
}

export function balanceStats(answered: readonly number[]) {
  if (answered.length === 0) return { min: 0, max: 0, mean: 0, sd: 0 };
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const value of answered) {
    if (value < min) min = value;
    if (value > max) max = value;
    sum += value;
  }
  const mean = sum / answered.length;
  let squares = 0;
  for (const value of answered) squares += (value - mean) ** 2;
  return { min, max, mean, sd: Math.sqrt(squares / answered.length) };
}

export function histogram(answered: readonly number[]): { answered: number; items: number }[] {
  const counts = new Map<number, number>();
  for (const value of answered) counts.set(value, (counts.get(value) ?? 0) + 1);
  if (counts.size === 0) return [];
  const low = Math.min(...counts.keys());
  const high = Math.max(...counts.keys());
  const rows: { answered: number; items: number }[] = [];
  for (let value = low; value <= high; value++) rows.push({ answered: value, items: counts.get(value) ?? 0 });
  return rows;
}

/** Builds a synthetic pool with given condition sizes. Used by the simulator's what-if scenarios. */
export function syntheticPool(counts: Record<Condition, number>, itemsPerAnchor = 5): PoolItem[] {
  const pool: PoolItem[] = [];
  let k = 0;
  for (const cond of CONDITIONS) {
    for (let i = 0; i < counts[cond]; i++) {
      const anchor = `A${Math.floor(k / itemsPerAnchor)}`;
      pool.push({ id: `${anchor}_${cond}_${i}`, anchor, b: `B${k}`, c: `C${k}`, cond });
      k++;
    }
  }
  return pool;
}

export interface SimulationConfig {
  participants: number;
  n: number;
  dropoutRate: number;
  concurrency: number;
  tolerance: number;
  seed: number;
  /** "engine" is the real allocator; "random" is the naive baseline it is compared against. */
  mode: "engine" | "random";
}

export interface SimulationCheckpoint {
  participants: number;
  range: number;
  sd: number;
  min: number;
  max: number;
}

export interface SimulationResult {
  mode: "engine" | "random";
  answered: number[];
  checkpoints: SimulationCheckpoint[];
  duplicates: number;
  anchorRepeats: number;
  overrides: number;
  released: number;
  dropouts: number;
  stranded: number;
  conditionTotals: Record<Condition, number>;
  perfectRatio: number;
  participantsSeen: number;
  responses: number;
}

interface SimParticipant {
  plan: Condition[];
  seen: Set<number>;
  anchors: Set<string>;
  left: number;
  dropAfter: number;
  answeredCounts: Record<string, number>;
  answered: number;
  open: number | null;
}

/**
 * Plays out a study with participants running in parallel: each step, one active
 * participant answers their open question and asks for the next one, exactly the
 * sequence the API performs. Dropouts leave with a question open.
 */
export function simulate(pool: readonly PoolItem[], config: SimulationConfig): SimulationResult {
  const rng = mulberry32(config.seed);
  const ledger = emptyLedger(pool.length);
  const quota = conditionQuota(config.n);
  const checkEvery = Math.max(1, Math.round(config.participants / 40));
  const checkpoints: SimulationCheckpoint[] = [];
  const conditionTotals = Object.fromEntries(CONDITIONS.map((c) => [c, 0])) as Record<Condition, number>;
  let duplicates = 0;
  let anchorRepeats = 0;
  let overrides = 0;
  let released = 0;
  let dropouts = 0;
  let started = 0;
  let finished = 0;
  let perfect = 0;
  let responses = 0;
  const active: SimParticipant[] = [];

  const openNext = (p: SimParticipant) => {
    if (p.left <= 0 || p.plan.length === 0) {
      p.open = null;
      return;
    }
    let chosen: number | null = null;
    if (config.mode === "random") {
      for (let tries = 0; tries < 200 && chosen === null; tries++) {
        const planned = p.plan[0];
        const i = Math.floor(rng() * pool.length);
        if (pool[i].cond === planned && !p.seen.has(i) && !p.anchors.has(pool[i].anchor)) chosen = i;
      }
    } else {
      const pick = pickNext(pool, ledger, { seenItems: p.seen, seenAnchors: p.anchors, plan: p.plan, tolerance: config.tolerance }, rng);
      if (pick) {
        chosen = pick.item;
        if (pick.reason !== "planned") overrides++;
      }
    }
    if (chosen === null) {
      p.open = null;
      p.left = 0;
      return;
    }
    if (p.seen.has(chosen)) duplicates++;
    if (p.anchors.has(pool[chosen].anchor)) anchorRepeats++;
    p.seen.add(chosen);
    p.anchors.add(pool[chosen].anchor);
    p.plan = consumePlan(p.plan, pool[chosen].cond);
    p.open = chosen;
    p.left--;
    ledger.reserved[chosen]++;
  };

  const finishParticipant = (p: SimParticipant, index: number, dropped: boolean) => {
    if (p.open !== null) {
      ledger.reserved[p.open]--;
      released++;
    }
    if (dropped) dropouts++;
    else if (CONDITIONS.every((c) => (p.answeredCounts[c] ?? 0) === quota[c])) perfect++;
    active.splice(index, 1);
    finished++;
    if (finished % checkEvery === 0 || finished === config.participants) {
      const stats = balanceStats(ledger.answered);
      checkpoints.push({ participants: finished, range: stats.max - stats.min, sd: stats.sd, min: stats.min, max: stats.max });
    }
  };

  while (finished < config.participants) {
    while (active.length < config.concurrency && started < config.participants) {
      const willDrop = rng() < config.dropoutRate;
      const p: SimParticipant = {
        plan: conditionPlan(config.n, rng),
        seen: new Set(),
        anchors: new Set(),
        left: config.n,
        dropAfter: willDrop ? Math.floor(rng() * config.n) : Infinity,
        answeredCounts: {},
        answered: 0,
        open: null,
      };
      started++;
      active.push(p);
      openNext(p);
    }
    const index = Math.floor(rng() * active.length);
    const p = active[index];
    if (p.answered >= p.dropAfter) {
      finishParticipant(p, index, true);
      continue;
    }
    if (p.open === null) {
      finishParticipant(p, index, false);
      continue;
    }
    ledger.reserved[p.open]--;
    ledger.answered[p.open]++;
    conditionTotals[pool[p.open].cond]++;
    p.answeredCounts[pool[p.open].cond] = (p.answeredCounts[pool[p.open].cond] ?? 0) + 1;
    p.answered++;
    responses++;
    p.open = null;
    openNext(p);
  }

  return {
    mode: config.mode,
    answered: ledger.answered,
    checkpoints,
    duplicates,
    anchorRepeats,
    overrides,
    released,
    dropouts,
    stranded: ledger.reserved.reduce((sum, value) => sum + value, 0),
    conditionTotals,
    perfectRatio: config.participants - dropouts > 0 ? perfect / (config.participants - dropouts) : 0,
    participantsSeen: finished,
    responses,
  };
}
