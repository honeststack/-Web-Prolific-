/**
 * Prints the figures quoted in docs/デモ説明ガイド.md, using the same code as the admin simulator.
 *   npx tsx scripts/simulation-report.ts
 */
import { balanceStats, simulate, syntheticPool } from "../shared/allocator";
import { CONDITIONS, Condition } from "../shared/types";

const POOLS: Record<string, Record<Condition, number>> = {
  ratio: { a: 600, b: 300, c: 300, d: 600, e: 300, f: 300, g: 600 },
  skewed: { a: 150, b: 600, c: 500, d: 250, e: 700, f: 500, g: 300 },
};

for (const [name, counts] of Object.entries(POOLS)) {
  const pool = syntheticPool(counts);
  for (const seed of [11, 22, 33]) {
    for (const mode of ["engine", "random"] as const) {
      const r = simulate(pool, { participants: 1000, n: 40, dropoutRate: 0.2, concurrency: 50, tolerance: 1, seed, mode });
      const s = balanceStats(r.answered);
      const total = CONDITIONS.reduce((sum, c) => sum + r.conditionTotals[c], 0);
      const share = CONDITIONS.map((c) => `${c}=${((r.conditionTotals[c] / total) * 100).toFixed(1)}`).join(" ");
      console.log(`${name} seed=${seed} ${mode}: min=${s.min} max=${s.max} range=${s.max - s.min} sd=${s.sd.toFixed(2)} dup=${r.duplicates} anchorRepeat=${r.anchorRepeats} overrides=${r.overrides} released=${r.released} dropouts=${r.dropouts} stranded=${r.stranded} perfect=${(r.perfectRatio * 100).toFixed(1)}% | ${share}`);
    }
  }
}
