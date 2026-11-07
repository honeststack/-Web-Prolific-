import { useMemo, useState } from "react";
import { balanceStats, histogram, simulate, SimulationResult, syntheticPool } from "../../shared/allocator";
import { CONDITIONS, CONDITION_WEIGHTS, Condition } from "../../shared/types";
import { Histogram, LineChart } from "./charts";

const POOLS: Record<string, { label: string; note: string; counts: Record<Condition, number> }> = {
  ratio: {
    label: "問題数が比率どおり（a,d,g=600 / 他=300）",
    note: "問題データ自体が 2:1:1:2:1:1:2 の場合です。均等化と条件比率が完全に両立します。",
    counts: { a: 600, b: 300, c: 300, d: 600, e: 300, f: 300, g: 600 },
  },
  skewed: {
    label: "問題数が偏っている（a=150, e=700 など）",
    note: "問題データと比率が合わない場合です。依頼文の優先順位どおり、回答数の均等化を優先します。",
    counts: { a: 150, b: 600, c: 500, d: 250, e: 700, f: 500, g: 300 },
  },
};

interface Outcome {
  engine: SimulationResult;
  random: SimulationResult;
  pool: string;
  n: number;
  participants: number;
}

const ENGINE_NAME = "本システム";
const RANDOM_NAME = "単純ランダム";

export function Simulation() {
  const [participants, setParticipants] = useState(1000);
  const [n, setN] = useState(40);
  const [dropout, setDropout] = useState(20);
  const [concurrency, setConcurrency] = useState(50);
  const [poolKey, setPoolKey] = useState("ratio");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, setRunning] = useState(false);

  const run = () => {
    setRunning(true);
    // Yield first so the button's running state paints before the work starts.
    setTimeout(() => {
      const pool = syntheticPool(POOLS[poolKey].counts);
      const base = { participants, n, dropoutRate: dropout / 100, concurrency, tolerance: 1, seed: Date.now() % 100000 };
      const engine = simulate(pool, { ...base, mode: "engine" });
      const random = simulate(pool, { ...base, mode: "random" });
      setOutcome({ engine, random, pool: poolKey, n, participants });
      setRunning(false);
    }, 30);
  };

  const view = useMemo(() => {
    if (!outcome) return null;
    const engine = balanceStats(outcome.engine.answered);
    const random = balanceStats(outcome.random.answered);
    const hEngine = histogram(outcome.engine.answered);
    const hRandom = histogram(outcome.random.answered);
    const low = Math.min(engine.min, random.min);
    const high = Math.max(engine.max, random.max);
    const fill = (rows: { answered: number; items: number }[]) => {
      const map = new Map(rows.map((r) => [r.answered, r.items]));
      const out = [];
      for (let v = low; v <= high; v++) out.push({ answered: v, items: map.get(v) ?? 0 });
      return out;
    };
    const yMax = Math.max(...hEngine.map((r) => r.items), ...hRandom.map((r) => r.items));
    return { engine, random, hEngine: fill(hEngine), hRandom: fill(hRandom), yMax };
  }, [outcome]);

  const totalWeight = CONDITIONS.reduce((sum, c) => sum + CONDITION_WEIGHTS[c], 0);

  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>均等化シミュレーション</h2>
            <p className="muted">実際の割り当てコードをブラウザ上で実行します。調査データには影響しません。比較対象は、参加者ごとに条件比率だけを守って問題を無作為に選ぶ単純な方式です。</p>
          </div>
        </div>
        <div className="form-row">
          <label className="field">
            参加者数
            <input type="number" min={50} max={3000} step={50} value={participants} onChange={(e) => setParticipants(clampNumber(e.target.value, 50, 3000))} />
          </label>
          <label className="field">
            出題数 N
            <input type="number" min={7} max={100} value={n} onChange={(e) => setN(clampNumber(e.target.value, 7, 100))} />
          </label>
          <label className="field">
            途中離脱率（%）
            <input type="number" min={0} max={80} value={dropout} onChange={(e) => setDropout(clampNumber(e.target.value, 0, 80))} />
          </label>
          <label className="field">
            同時参加人数
            <input type="number" min={1} max={500} value={concurrency} onChange={(e) => setConcurrency(clampNumber(e.target.value, 1, 500))} />
          </label>
          <label className="field grow">
            問題データの構成
            <select value={poolKey} onChange={(e) => setPoolKey(e.target.value)}>
              {Object.entries(POOLS).map(([key, value]) => (
                <option key={key} value={key}>
                  {value.label}
                </option>
              ))}
            </select>
          </label>
          <button className="button primary align-end" onClick={run} disabled={running}>
            {running ? "実行中…" : "実行"}
          </button>
        </div>
        <p className="muted small">{POOLS[poolKey].note}</p>
      </section>

      {outcome && view && (
        <>
          <section className="tile-row">
            <Tile label="回答数のばらつき（最大−最小）" value={`${view.engine.max - view.engine.min}`} sub={`${RANDOM_NAME}では ${view.random.max - view.random.min}`} />
            <Tile label="標準偏差" value={view.engine.sd.toFixed(2)} sub={`${RANDOM_NAME}では ${view.random.sd.toFixed(2)}`} />
            <Tile label="回答が最も少ない問題の回答数" value={`${view.engine.min} 回答`} sub={`${RANDOM_NAME}では ${view.random.min} 回答`} />
            <Tile label="同一問題の重複出題" value={`${outcome.engine.duplicates} 件`} sub={`離脱 ${outcome.engine.dropouts} 人、解放 ${outcome.engine.released} 問`} />
          </section>

          <section className="panel">
            <LineChart
              title="参加者が増えるにつれての回答数のばらつき"
              xLabel="参加者数"
              yLabel="問題別回答数の 最大−最小"
              series={[
                { name: ENGINE_NAME, points: outcome.engine.checkpoints.map((c) => ({ x: c.participants, y: c.range })) },
                { name: RANDOM_NAME, points: outcome.random.checkpoints.map((c) => ({ x: c.participants, y: c.range })) },
              ]}
            />
          </section>

          <section className="two-col">
            <div className="panel">
              <Histogram title={`問題別の回答数：${ENGINE_NAME}`} rows={view.hEngine} xLabel="1問あたりの回答数" yMax={view.yMax} />
            </div>
            <div className="panel">
              <Histogram title={`問題別の回答数：${RANDOM_NAME}`} rows={view.hRandom} xLabel="1問あたりの回答数" yMax={view.yMax} seriesIndex={1} />
            </div>
          </section>

          <section className="panel">
            <h3>条件別の出題比率（{ENGINE_NAME}）</h3>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>条件</th>
                    <th className="num">問題数</th>
                    <th className="num">目標比率</th>
                    <th className="num">実際の比率</th>
                    <th className="num">1問あたり平均回答数</th>
                  </tr>
                </thead>
                <tbody>
                  {CONDITIONS.map((c) => {
                    const total = CONDITIONS.reduce((sum, k) => sum + outcome.engine.conditionTotals[k], 0);
                    const items = POOLS[outcome.pool].counts[c];
                    return (
                      <tr key={c}>
                        <td>{c}</td>
                        <td className="num">{items.toLocaleString()}</td>
                        <td className="num">{((CONDITION_WEIGHTS[c] / totalWeight) * 100).toFixed(1)}%</td>
                        <td className="num">{((outcome.engine.conditionTotals[c] / Math.max(1, total)) * 100).toFixed(1)}%</td>
                        <td className="num">{(outcome.engine.conditionTotals[c] / items).toFixed(2)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              完走者のうち条件別の出題数が計画どおりだった割合：{(outcome.engine.perfectRatio * 100).toFixed(1)}%　／　均等化を優先して条件を変更した回数：{outcome.engine.overrides.toLocaleString()} 回
            </p>
          </section>
        </>
      )}
    </div>
  );
}

function clampNumber(text: string, low: number, high: number) {
  const value = Number(text);
  return Number.isFinite(value) ? Math.max(low, Math.min(high, Math.round(value))) : low;
}

export function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "alert" }) {
  return (
    <div className={`tile ${tone === "alert" ? "tile-alert" : ""}`}>
      <p className="tile-label">{label}</p>
      <p className="tile-value">{value}</p>
      {sub && <p className="tile-sub">{sub}</p>}
    </div>
  );
}
