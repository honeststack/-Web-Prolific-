import { useCallback, useEffect, useMemo, useState } from "react";
import { runLoadTest, LoadTestResult } from "../../shared/driver";
import { AdminSummary, ImageErrorRecord, ItemRow, Settings } from "../../shared/types";
import { adminClient, AdminClient, getInfo, HttpError } from "../api";
import { Histogram } from "./charts";
import { Simulation, Tile } from "./Simulation";

type Tab = "overview" | "items" | "participants" | "data" | "tests" | "simulation" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "概要" },
  { id: "items", label: "問題別状況" },
  { id: "participants", label: "参加者" },
  { id: "data", label: "データ取込・画像" },
  { id: "settings", label: "調査設定" },
  { id: "simulation", label: "シミュレーション" },
  { id: "tests", label: "動作試験" },
];

const STATUS_LABEL: Record<string, string> = {
  in_progress: "回答中",
  completed: "完了",
  dropped: "離脱",
  terminated_comprehension: "理解度で終了",
  declined: "不同意",
};
const SOURCE_LABEL: Record<string, string> = { prolific: "Prolific", demo: "デモ操作", simulated: "模擬", loadtest: "負荷試験" };
const PASSWORD_KEY = "fp-admin-password";

function loadPassword(): string {
  try {
    return sessionStorage.getItem(PASSWORD_KEY) ?? "";
  } catch {
    return "";
  }
}
function savePassword(value: string) {
  try {
    sessionStorage.setItem(PASSWORD_KEY, value);
  } catch {
    // Storage may be blocked: the password just lasts until reload.
  }
}

export default function Admin() {
  const [client, setClient] = useState<AdminClient | null>(null);
  const [hint, setHint] = useState<string | undefined>();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const initial = new URLSearchParams(window.location.search).get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(initial && TABS.some((t) => t.id === initial) ? initial : "overview");

  const login = useCallback(async (value: string) => {
    const candidate = adminClient(value);
    try {
      await candidate.get("/items");
      savePassword(value);
      setClient(candidate);
      setError("");
    } catch (e) {
      setError(e instanceof HttpError && e.status === 401 ? "パスワードが正しくありません。" : "サーバーに接続できません。");
    }
  }, []);

  useEffect(() => {
    const saved = loadPassword();
    getInfo()
      .then((info) => {
        setHint(info.demoPassword);
        const start = saved || info.demoPassword;
        if (start) void login(start);
      })
      .catch(() => setError("サーバーに接続できません。"));
  }, [login]);

  if (!client) {
    return (
      <div className="login">
        <form
          className="panel login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void login(password);
          }}
        >
          <h1>管理画面</h1>
          <label className="field">
            パスワード
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {hint && <p className="muted small">デモ用パスワード：{hint}</p>}
          <button className="button primary wide">ログイン</button>
        </form>
      </div>
    );
  }
  return <Dashboard client={client} tab={tab} setTab={setTab} />;
}

function Dashboard({ client, tab, setTab }: { client: AdminClient; tab: Tab; setTab: (tab: Tab) => void }) {
  const [summary, setSummary] = useState<AdminSummary | null>(null);
  const [failed, setFailed] = useState("");

  const refresh = useCallback(async () => {
    try {
      setSummary(await client.get<AdminSummary>("/summary"));
      setFailed("");
    } catch (e) {
      setFailed((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 6000);
    return () => clearInterval(timer);
  }, [refresh]);

  return (
    <div className="admin">
      <header className="admin-bar">
        <a href="/" className="admin-brand">
          間取り図類似性調査 <span>管理画面</span>
        </a>
        {summary && (
          <div className="admin-status">
            <StatusPill paused={summary.settings.paused} />
            <span className="phase-tag">{summary.settings.phase === "pilot" ? "パイロット" : "本調査"}</span>
          </div>
        )}
      </header>
      <nav className="admin-tabs" aria-label="管理メニュー">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "is-on" : ""} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="admin-main">
        {failed && (
          <p className="notice" role="alert">
            データを更新できませんでした：{failed}
          </p>
        )}
        {tab === "simulation" && <Simulation />}
        {tab !== "simulation" && !summary && <div className="page-loading" />}
        {tab !== "simulation" && summary && (
          <>
            {tab === "overview" && <Overview summary={summary} client={client} refresh={refresh} />}
            {tab === "items" && <Items client={client} />}
            {tab === "participants" && <Participants summary={summary} />}
            {tab === "data" && <DataTab summary={summary} client={client} refresh={refresh} />}
            {tab === "settings" && <SettingsTab summary={summary} client={client} refresh={refresh} />}
            {tab === "tests" && <Tests client={client} refresh={refresh} />}
          </>
        )}
      </main>
    </div>
  );
}

function StatusPill({ paused }: { paused: boolean }) {
  return (
    <span className={`status-pill ${paused ? "is-paused" : "is-live"}`}>
      <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
        {paused ? <path d="M3 2h2v8H3zM7 2h2v8H7z" fill="currentColor" /> : <circle cx="6" cy="6" r="4" fill="currentColor" />}
      </svg>
      {paused ? "一時停止中" : "受付中"}
    </span>
  );
}

function ExportButtons({ client }: { client: AdminClient }) {
  const [excludeTest, setExcludeTest] = useState(false);
  const [error, setError] = useState("");
  const download = (type: string) => client.download(type, excludeTest).catch((e) => setError((e as Error).message));
  return (
    <div className="export-row">
      <button className="button secondary" onClick={() => void download("responses")}>
        回答データCSV
      </button>
      <button className="button secondary" onClick={() => void download("participants")}>
        参加者CSV
      </button>
      <button className="button secondary" onClick={() => void download("items")}>
        問題別CSV
      </button>
      <label className="check-inline">
        <input type="checkbox" checked={excludeTest} onChange={(e) => setExcludeTest(e.target.checked)} />
        デモ・模擬データを除く
      </label>
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

function Overview({ summary, client, refresh }: { summary: AdminSummary; client: AdminClient; refresh: () => Promise<void> }) {
  const { participants: p, responses: r, balance: b } = summary;
  const [busy, setBusy] = useState(false);
  const [seeded, setSeeded] = useState("");

  const togglePause = async () => {
    setBusy(true);
    await client.post("/settings", { paused: !summary.settings.paused });
    await refresh();
    setBusy(false);
  };
  const seed = async () => {
    setBusy(true);
    const { created } = await client.post<{ created: number }>("/seed", { count: 30 });
    setSeeded(`模擬参加者を${created}人追加しました（CSVでは source=simulated）。`);
    await refresh();
    setBusy(false);
  };

  const maxFunnel = Math.max(1, ...summary.funnel.map((f) => f.count));

  return (
    <div className="stack">
      <section className="panel control-bar">
        <div>
          <h2>調査の受付</h2>
          <p className="muted">{summary.settings.paused ? "新規の参加者を受け付けていません。回答中の方はそのまま続けられます。" : "新規の参加者を受け付けています。"}</p>
        </div>
        <button className={`button ${summary.settings.paused ? "primary" : "secondary"}`} onClick={() => void togglePause()} disabled={busy}>
          {summary.settings.paused ? "調査を再開" : "調査を一時停止"}
        </button>
      </section>

      <section className="tile-row">
        <Tile label="参加者" value={p.total.toLocaleString()} sub={`回答中 ${p.active} ／ 完了 ${p.completed}`} />
        <Tile label="離脱・終了" value={(p.dropped + p.terminated + p.declined).toLocaleString()} sub={`離脱 ${p.dropped} ／ 理解度 ${p.terminated} ／ 不同意 ${p.declined}`} />
        <Tile label="本試行の回答数" value={r.main.toLocaleString()} sub={`全保存行 ${r.total.toLocaleString()}`} />
        <Tile label="問題別の回答数" value={`${b.min} 〜 ${b.max}`} sub={`平均 ${b.mean.toFixed(2)} ／ 全 ${summary.poolSize.toLocaleString()} 問`} />
      </section>

      {p.total === 0 && (
        <section className="panel empty-state">
          <h2>まだ回答がありません</h2>
          <p className="muted">実際に回答するか、模擬参加者を追加すると、グラフと表にデータが表示されます。</p>
        </section>
      )}

      <section className="two-col">
        <div className="panel">
          <Histogram title="問題別の回答数の分布" rows={b.histogram} xLabel="1問あたりの回答数" />
          <p className="muted small">
            回答中で確保されている問題 {b.reserved} ／ 離脱で解放された問題 累計 {b.releases} ／ 出題停止中 {b.blocked}
          </p>
        </div>
        <div className="panel">
          <h3>各段階の到達人数</h3>
          <div className="funnel">
            {summary.funnel.map((f) => (
              <div className="funnel-row" key={f.stage}>
                <span className="funnel-label">{f.label}</span>
                <div className="meter">
                  <div style={{ width: `${(f.count / maxFunnel) * 100}%` }} />
                </div>
                <span className="funnel-count">{f.count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="panel">
        <h3>抽出条件別の収集状況</h3>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>条件</th>
                <th className="num">問題数</th>
                <th className="num">回答数</th>
                <th className="num">目標比率</th>
                <th className="num">実際の比率</th>
                <th className="num">問題別の最小〜最大</th>
              </tr>
            </thead>
            <tbody>
              {summary.conditions.map((c) => (
                <tr key={c.condition}>
                  <td>{c.condition}</td>
                  <td className="num">{c.items.toLocaleString()}</td>
                  <td className="num">{c.answered.toLocaleString()}</td>
                  <td className="num">{(c.targetShare * 100).toFixed(1)}%</td>
                  <td className="num">{(c.actualShare * 100).toFixed(1)}%</td>
                  <td className="num">
                    {c.minAnswered} 〜 {c.maxAnswered}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h3>データ出力</h3>
        <ExportButtons client={client} />
      </section>

      {summary.demoMode && (
        <section className="panel control-bar">
          <div>
            <h3>デモ用データ</h3>
            <p className="muted">{seeded || "実際の割り当て処理を通った模擬参加者30人（離脱約15%）を追加します。"}</p>
          </div>
          <button className="button secondary" onClick={() => void seed()} disabled={busy}>
            模擬参加者を追加
          </button>
        </section>
      )}
    </div>
  );
}

const PAGE = 50;
function Items({ client }: { client: AdminClient }) {
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [condition, setCondition] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"id" | "low" | "high" | "errors">("low");
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(() => client.get<ItemRow[]>("/items").then(setItems), [client]);
  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => {
    if (!items) return [];
    const needle = query.trim().toLowerCase();
    const filtered = items.filter((i) => (condition === "all" || i.condition === condition) && (!needle || i.id.toLowerCase().includes(needle) || i.anchorId.includes(needle)));
    const sorted = [...filtered];
    if (sort === "low") sorted.sort((x, y) => x.answered - y.answered || x.index - y.index);
    if (sort === "high") sorted.sort((x, y) => y.answered - x.answered || x.index - y.index);
    if (sort === "errors") sorted.sort((x, y) => y.errorReports - x.errorReports || x.index - y.index);
    return sorted;
  }, [condition, items, query, sort]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = rows.slice(current * PAGE, (current + 1) * PAGE);

  const setBlocked = async (id: string, blocked: boolean) => {
    await client.post("/block", { tripletId: id, blocked });
    await load();
  };

  if (!items) return <div className="page-loading" />;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>問題別の収集状況</h2>
        <span className="muted">{rows.length.toLocaleString()} 問</span>
      </div>
      <div className="form-row">
        <label className="field">
          抽出条件
          <select
            value={condition}
            onChange={(e) => {
              setCondition(e.target.value);
              setPage(0);
            }}
          >
            <option value="all">すべて</option>
            {"abcdefg".split("").map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          並び順
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="low">回答数が少ない順</option>
            <option value="high">回答数が多い順</option>
            <option value="errors">画像エラーが多い順</option>
            <option value="id">登録順</option>
          </select>
        </label>
        <label className="field grow">
          問題ID・基準IDで検索
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            placeholder="例：10015_a_1"
          />
        </label>
      </div>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>問題ID</th>
              <th>条件</th>
              <th>基準A</th>
              <th className="num">回答数</th>
              <th className="num">回答中</th>
              <th className="num">画像エラー</th>
              <th>状態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((item) => (
              <tr key={item.id}>
                <td>
                  <button className="link-button mono" onClick={() => setPreview(preview === item.id ? null : item.id)}>
                    {item.id}
                  </button>
                  {preview === item.id && (
                    <div className="thumbs">
                      {["a", "b", "c"].map((role) => (
                        <figure key={role}>
                          <img src={`/RPLAN_triplets/${item.id}/${role}.png`} alt={`${item.id} ${role}`} loading="lazy" />
                          <figcaption>{role}.png</figcaption>
                        </figure>
                      ))}
                    </div>
                  )}
                </td>
                <td>{item.condition}</td>
                <td className="mono">{item.anchorId}</td>
                <td className="num">{item.answered}</td>
                <td className="num">{item.reserved}</td>
                <td className="num">{item.errorReports}</td>
                <td>{item.blocked ? "出題停止" : "出題中"}</td>
                <td className="right">
                  <button className="link-button" onClick={() => void setBlocked(item.id, !item.blocked)}>
                    {item.blocked ? "再開" : "停止"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pager">
        <button className="button quiet" disabled={current === 0} onClick={() => setPage(current - 1)}>
          前へ
        </button>
        <span>
          {current + 1} / {pages} ページ
        </span>
        <button className="button quiet" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
          次へ
        </button>
      </div>
    </section>
  );
}

function Participants({ summary }: { summary: AdminSummary }) {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>参加者</h2>
        <span className="muted">新しい順に最大200人を表示（全件はCSVで出力）</span>
      </div>
      {summary.sessions.length === 0 ? (
        <p className="muted">まだ参加者がいません。</p>
      ) : (
        <div className="table-scroll tall">
          <table className="data-table">
            <thead>
              <tr>
                <th>Prolific ID</th>
                <th>Study ID</th>
                <th>Session ID</th>
                <th>区分</th>
                <th>状態</th>
                <th className="num">本試行</th>
                <th className="num">注意力 合/否</th>
                <th className="num">アクセス回数</th>
                <th>最終更新</th>
              </tr>
            </thead>
            <tbody>
              {summary.sessions.map((s) => (
                <tr key={s.pid}>
                  <td className="mono">{s.pid}</td>
                  <td className="mono">{s.studyId}</td>
                  <td className="mono truncate">{s.sessionId}</td>
                  <td>{SOURCE_LABEL[s.source] ?? s.source}</td>
                  <td>{STATUS_LABEL[s.status] ?? s.status}</td>
                  <td className="num">
                    {s.mainAnswered} / {s.n}
                  </td>
                  <td className="num">
                    {s.attentionPassed} / {s.attentionFailed}
                  </td>
                  <td className="num">{s.accessCount}</td>
                  <td>{new Date(s.updatedAt).toLocaleString("ja-JP")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface Report {
  source: string;
  ok: boolean;
  rows: number;
  validTriplets: number;
  uniqueAnchors: number;
  imagesExpected: number;
  imagesValid: number;
  conditionCounts: Record<string, number>;
  errorCounts: Record<string, number>;
  warningCounts: Record<string, number>;
  errors: { type: string; tripletId?: string; detail: string }[];
  warnings: { type: string; tripletId?: string; detail: string }[];
}

function ReportCard({ title, report, expectDefects }: { title: string; report: Report; expectDefects?: boolean }) {
  const issues = [...report.errors, ...report.warnings];
  return (
    <div className="panel">
      <h3>{title}</h3>
      <p className="muted small">{report.source}</p>
      <dl className="kv">
        <dt>CSV行数</dt>
        <dd>{report.rows.toLocaleString()}</dd>
        <dt>正常な問題</dt>
        <dd>{report.validTriplets.toLocaleString()}</dd>
        <dt>正常な画像</dt>
        <dd>
          {report.imagesValid.toLocaleString()} / {report.imagesExpected.toLocaleString()}
        </dd>
        <dt>基準Aの種類</dt>
        <dd>{report.uniqueAnchors.toLocaleString()}</dd>
        <dt>条件別</dt>
        <dd>
          {Object.entries(report.conditionCounts)
            .map(([c, count]) => `${c}:${count}`)
            .join(" ")}
        </dd>
      </dl>
      <p className={`result-line ${report.ok ? "is-good" : "is-bad"}`}>
        {report.ok ? "✓ 欠損・破損なし" : `✕ エラー ${report.errors.length} 件を検出${expectDefects ? "（意図どおり）" : ""}`}
        {report.warnings.length > 0 && ` ／ 警告 ${report.warnings.length} 件`}
      </p>
      {issues.length > 0 && (
        <div className="table-scroll short">
          <table className="data-table">
            <thead>
              <tr>
                <th>種類</th>
                <th>問題ID</th>
                <th>内容</th>
              </tr>
            </thead>
            <tbody>
              {issues.slice(0, 40).map((issue, i) => (
                <tr key={i}>
                  <td>{issue.type}</td>
                  <td className="mono">{issue.tripletId ?? "-"}</td>
                  <td>{issue.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DataTab({ summary, client, refresh }: { summary: AdminSummary; client: AdminClient; refresh: () => Promise<void> }) {
  const block = async (record: ImageErrorRecord) => {
    await client.post("/block", { tripletId: record.tripletId, blocked: true });
    await refresh();
  };
  return (
    <div className="stack">
      <section className="two-col">
        {summary.importReport ? <ReportCard title="取り込み結果（現在のデータ）" report={summary.importReport as Report} /> : null}
        {summary.defectReport ? <ReportCard title="検出能力の確認（破損サンプル）" report={summary.defectReport as Report} expectDefects /> : null}
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2>参加者の画面で発生した画像エラー</h2>
          <span className="muted">{summary.imageErrors.length} 件</span>
        </div>
        <p className="muted small">読み込みに2回失敗すると、その参加者には別の問題を出題し、ここに記録します。{summary.settings.imageErrorBlockThreshold}人から報告された問題は自動で出題を停止します。</p>
        {summary.imageErrors.length === 0 ? (
          <p className="muted">画像エラーは記録されていません。</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>日時</th>
                  <th>問題ID</th>
                  <th>参加者</th>
                  <th>URL・内容</th>
                  <th>区分</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {summary.imageErrors.map((record, i) => (
                  <tr key={i}>
                    <td>{new Date(record.at).toLocaleString("ja-JP")}</td>
                    <td className="mono">{record.tripletId}</td>
                    <td className="mono truncate">{record.pid}</td>
                    <td className="truncate">{record.url}</td>
                    <td>{record.simulated ? "デモで発生" : "実エラー"}</td>
                    <td className="right">
                      {record.kind === "main" && (
                        <button className="link-button" onClick={() => void block(record)}>
                          出題停止
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsTab({ summary, client, refresh }: { summary: AdminSummary; client: AdminClient; refresh: () => Promise<void> }) {
  const [form, setForm] = useState<Settings>(summary.settings);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState("");
  const started = summary.participants.total > 0;
  const studyUrl = `${window.location.origin}/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`;
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) => setForm((f) => ({ ...f, [key]: value }));
  const quota = useMemo(() => {
    const n = Number(form.n) || 0;
    return { total: n + 2 };
  }, [form.n]);

  const save = async () => {
    try {
      // Pausing has its own button; saving this form must not overwrite its current state.
      const { paused: _paused, updatedAt: _updatedAt, ...editable } = form;
      await client.post("/settings", editable);
      await refresh();
      setMessage({ ok: true, text: "保存しました。" });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };
  const reset = async () => {
    await client.post("/reset");
    setConfirmReset("");
    await refresh();
    setMessage({ ok: true, text: "全データを削除しました。" });
  };

  return (
    <div className="stack">
      <section className="panel">
        <h2>ProlificのStudy URL</h2>
        <p className="muted small">Prolificの「Study URL」にそのまま貼り付けます。参加者ごとのIDはProlificが埋め込みます。</p>
        <div className="copy-row">
          <code>{studyUrl}</code>
          <button className="button secondary" onClick={() => void navigator.clipboard?.writeText(studyUrl)}>
            コピー
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>調査の設定</h2>
        <div className="settings-grid">
          <label className="field">
            本試行の出題数 N
            <input type="number" min={1} value={form.n} disabled={started} onChange={(e) => set("n", Number(e.target.value))} />
            <small>{started ? "参加者データがあるため変更できません（リセット後に変更可）。" : `注意力確認を含めて全 ${quota.total} 問になります。`}</small>
          </label>
          <label className="field">
            調査段階
            <select value={form.phase} onChange={(e) => set("phase", e.target.value as Settings["phase"])}>
              <option value="pilot">パイロット</option>
              <option value="main">本調査</option>
            </select>
            <small>回答データに記録され、CSVで区別できます。</small>
          </label>
          <label className="field span-2">
            Prolificの完了URL
            <input value={form.completionUrl} onChange={(e) => set("completionUrl", e.target.value)} placeholder="https://app.prolific.com/submissions/complete?cc=XXXXXXX" />
            <small>回答の保存を確認した後に、このURLへ移動します。</small>
          </label>
          <label className="field">
            完了後の自動遷移（秒）
            <input type="number" min={0} value={form.redirectSeconds} onChange={(e) => set("redirectSeconds", Number(e.target.value))} />
            <small>0 にするとボタンのみになります。</small>
          </label>
          <label className="field">
            B・Cのラベルの扱い
            <select value={form.labelMode} onChange={(e) => set("labelMode", e.target.value as Settings["labelMode"])}>
              <option value="follow_image">画像に固定（左右に関わらずb画像＝B）</option>
              <option value="fixed_position">位置に固定（常に左＝B）</option>
            </select>
            <small>どちらでも選択画像IDは正しく記録されます。ご確認事項です。</small>
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>離脱の検知と再割り当て</h2>
        <p className="muted small">タイムアウトはご相談のうえ決定する項目のため、調整できるようにしています。</p>
        <div className="settings-grid">
          <label className="field">
            タブを閉じた後の猶予（秒）
            <input type="number" min={0} value={form.leaveGraceSec} onChange={(e) => set("leaveGraceSec", Number(e.target.value))} />
            <small>再読み込みと離脱を区別するための時間です。「戻る」操作は猶予なしで解放します。</small>
          </label>
          <label className="field">
            通信途絶の判定（秒）
            <input type="number" min={30} value={form.heartbeatTimeoutSec} onChange={(e) => set("heartbeatTimeoutSec", Number(e.target.value))} />
            <small>ブラウザからの定期通信（30秒ごと）が途絶えてからの時間です。</small>
          </label>
          <label className="field">
            1問の上限時間（秒）
            <input type="number" min={60} value={form.idleTimeoutSec} onChange={(e) => set("idleTimeoutSec", Number(e.target.value))} />
            <small>開いたまま放置された問題を解放します。解放後に届いた回答も保存します。</small>
          </label>
        </div>
      </section>

      <section className="panel">
        <h2>均等化と画像エラー</h2>
        <div className="settings-grid">
          <label className="field">
            条件比率を優先する許容差
            <input type="number" min={0} max={5} value={form.balanceTolerance} onChange={(e) => set("balanceTolerance", Number(e.target.value))} />
            <small>最少回答数との差がこの値を超えると、条件比率より均等化を優先します。</small>
          </label>
          <label className="field">
            出題停止までの報告数
            <input type="number" min={1} value={form.imageErrorBlockThreshold} onChange={(e) => set("imageErrorBlockThreshold", Number(e.target.value))} />
            <small>一時的な通信不良で問題が止まらないよう、複数人の報告で停止します。</small>
          </label>
          <label className="check-field span-2">
            <input type="checkbox" checked={form.excludeFailedAttention} onChange={(e) => set("excludeFailedAttention", e.target.checked)} />
            <span>
              注意力確認に不合格の完了者を、問題別の回答数カウントから除外する
              <small>回答データは削除しません。除外分は他の参加者に再度割り当てられます。</small>
            </span>
          </label>
        </div>
        <div className="save-row">
          <button className="button primary" onClick={() => void save()}>
            設定を保存
          </button>
          {message && (
            <span className={message.ok ? "result-line is-good" : "field-error"} role="status">
              {message.text}
            </span>
          )}
        </div>
      </section>

      <section className="panel danger-zone">
        <h2>データの全削除</h2>
        <p className="muted small">参加者と回答をすべて削除します。元に戻せません。パイロット終了後に本調査を始める際などに使います。先にCSVを保存してください。</p>
        <div className="form-row">
          <label className="field">
            確認のため「削除」と入力
            <input value={confirmReset} onChange={(e) => setConfirmReset(e.target.value)} />
          </label>
          <button className="button danger align-end" disabled={confirmReset !== "削除"} onClick={() => void reset()}>
            全データを削除
          </button>
        </div>
      </section>
    </div>
  );
}

interface ReconcileResult {
  savedResponses: number;
  ledgerResponses: number;
  mismatchedItems: number;
  duplicateAssignments: number;
}

function Tests({ client, refresh }: { client: AdminClient; refresh: () => Promise<void> }) {
  const [participants, setParticipants] = useState(20);
  const [questions, setQuestions] = useState(6);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<LoadTestResult | null>(null);
  const [check, setCheck] = useState<ReconcileResult | null>(null);
  const [error, setError] = useState("");

  const verify = async () => {
    const next = await client.post<ReconcileResult>("/reconcile");
    setCheck(next);
    return next;
  };

  const run = async () => {
    setRunning(true);
    setError("");
    setResult(null);
    setCheck(null);
    try {
      const outcome = await runLoadTest({
        baseUrl: window.location.origin,
        participants,
        questionsEach: questions,
        onProgress: (done, total) => setProgress(`${done} / ${total} 回答`),
      });
      setResult(outcome);
      await verify();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
      setProgress("");
    }
  };

  const uniqueShare = result ? new Set(result.assignments).size : 0;

  return (
    <div className="stack">
      <section className="panel">
        <h2>同時アクセス試験</h2>
        <p className="muted">
          仮想参加者が実際のサーバーへ同時に接続し、同意から本試行までを進めます。作成されたデータはCSVで source=loadtest と記録されます。
          {" "}試験後は、設定画面の全削除でデータを消去できます。
        </p>
        <div className="form-row">
          <label className="field">
            同時参加人数
            <input type="number" min={2} max={60} value={participants} onChange={(e) => setParticipants(Math.max(2, Math.min(60, Number(e.target.value) || 2)))} />
          </label>
          <label className="field">
            1人あたりの回答数
            <input type="number" min={1} max={40} value={questions} onChange={(e) => setQuestions(Math.max(1, Math.min(40, Number(e.target.value) || 1)))} />
          </label>
          <button className="button primary align-end" disabled={running} onClick={() => void run()}>
            {running ? progress || "接続中…" : "試験を開始"}
          </button>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </section>

      {result && (
        <section className="tile-row">
          <Tile label="保存された回答" value={`${result.totalAnswers} / ${result.participants * result.questionsEach}`} sub={`所要 ${(result.durationMs / 1000).toFixed(1)} 秒`} />
          <Tile label="同一参加者への重複出題" value={`${result.duplicateWithinParticipant} 件`} sub={`出題された問題 ${uniqueShare} 種類`} />
          <Tile label="1回答の保存時間" value={`${result.medianSaveMs} ms`} sub={`95%は ${result.p95SaveMs} ms 以内`} />
          <Tile label="失敗した参加者" value={`${result.failures} 人`} tone={result.failures ? "alert" : undefined} sub={`自動再送 ${result.retries} 回`} />
        </section>
      )}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>データ整合性チェック</h2>
            <p className="muted small">保存済みの全回答から問題別の回答数を数え直し、割り当てに使っている集計と照合します。</p>
          </div>
          <button className="button secondary" onClick={() => void verify()}>
            今すぐ照合
          </button>
        </div>
        {check && (
          <p className={`result-line ${check.mismatchedItems === 0 && check.duplicateAssignments === 0 ? "is-good" : "is-bad"}`} role="status">
            {check.mismatchedItems === 0 && check.duplicateAssignments === 0 ? "✓ 一致" : "✕ 不一致あり"}：保存済み {check.savedResponses.toLocaleString()} 回答 ／ 集計 {check.ledgerResponses.toLocaleString()} 回答 ／ 不一致 {check.mismatchedItems} 問 ／ 重複出題 {check.duplicateAssignments} 人
          </p>
        )}
      </section>
    </div>
  );
}
