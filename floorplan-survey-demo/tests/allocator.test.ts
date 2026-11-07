import { describe, expect, it } from "vitest";
import { attentionPositions, balanceStats, conditionPlan, conditionQuota, mulberry32, simulate, syntheticPool } from "../shared/allocator";
import { CONDITIONS, Condition } from "../shared/types";

const RATIO_POOL: Record<Condition, number> = { a: 600, b: 300, c: 300, d: 600, e: 300, f: 300, g: 600 };
const SKEWED_POOL: Record<Condition, number> = { a: 150, b: 600, c: 500, d: 250, e: 700, f: 500, g: 300 };
const base = { n: 40, dropoutRate: 0, concurrency: 30, tolerance: 1, seed: 7, mode: "engine" as const };

describe("condition quota", () => {
  it("gives 8/4/4/8/4/4/8 at N=40", () => {
    expect(conditionQuota(40)).toEqual({ a: 8, b: 4, c: 4, d: 8, e: 4, f: 4, g: 8 });
  });

  it.each([1, 7, 10, 23, 41, 50, 99, 137])("always sums to N and stays near the ratio at N=%i", (n) => {
    const quota = conditionQuota(n);
    expect(CONDITIONS.reduce((sum, c) => sum + quota[c], 0)).toBe(n);
    for (const c of ["a", "d", "g"] as const) expect(Math.abs(quota[c] - n * 0.2)).toBeLessThanOrEqual(1);
    for (const c of ["b", "c", "e", "f"] as const) expect(Math.abs(quota[c] - n * 0.1)).toBeLessThanOrEqual(1);
  });

  it("randomizes the plan without changing its contents", () => {
    const plan = conditionPlan(40, mulberry32(1));
    expect(plan).toHaveLength(40);
    expect([...plan].sort().join("")).toBe("aaaaaaaabbbbccccddddddddeeeeffffgggggggg");
    expect(plan).not.toEqual(conditionPlan(40, mulberry32(2)));
  });
});

describe("attention positions", () => {
  it("matches the agreed flow at N=40", () => {
    expect(attentionPositions(40)).toEqual([16, 31]);
  });
  it.each([1, 2, 5, 20, 60, 100])("gives two distinct valid positions at N=%i", (n) => {
    const [first, second] = attentionPositions(n);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThanOrEqual(n + 2);
  });
});

describe("simulated study", () => {
  it("keeps a ratio-shaped pool flat with the exact ratio per participant", () => {
    const result = simulate(syntheticPool(RATIO_POOL), { ...base, participants: 300 });
    const stats = balanceStats(result.answered);
    // Tolerance 1 lets the planned condition sit one above the minimum, so the spread is at most 2.
    expect(stats.max - stats.min).toBeLessThanOrEqual(2);
    expect(result.duplicates).toBe(0);
    expect(result.anchorRepeats).toBe(0);
    expect(result.perfectRatio).toBe(1);
    expect(result.stranded).toBe(0);
  });

  it("stays flat with dropouts, and strands nothing", () => {
    const result = simulate(syntheticPool(RATIO_POOL), { ...base, participants: 400, dropoutRate: 0.25 });
    const stats = balanceStats(result.answered);
    expect(result.dropouts).toBeGreaterThan(50);
    expect(stats.max - stats.min).toBeLessThanOrEqual(2);
    expect(result.duplicates).toBe(0);
    expect(result.stranded).toBe(0);
  });

  it("puts balance ahead of the ratio when the pool does not match it", () => {
    const result = simulate(syntheticPool(SKEWED_POOL), { ...base, participants: 300, dropoutRate: 0.1 });
    const stats = balanceStats(result.answered);
    expect(stats.max - stats.min).toBeLessThanOrEqual(2);
    expect(result.overrides).toBeGreaterThan(0);
    expect(result.duplicates).toBe(0);
  });

  it("is far flatter than random assignment", () => {
    const pool = syntheticPool(RATIO_POOL);
    const engine = balanceStats(simulate(pool, { ...base, participants: 300 }).answered);
    const random = balanceStats(simulate(pool, { ...base, participants: 300, mode: "random" }).answered);
    expect(random.max - random.min).toBeGreaterThan((engine.max - engine.min) * 4);
  });

  it("never repeats a question even past the size of the pool", () => {
    const result = simulate(syntheticPool({ a: 12, b: 6, c: 6, d: 12, e: 6, f: 6, g: 12 }), { ...base, participants: 20, n: 40 });
    expect(result.duplicates).toBe(0);
  });
});
