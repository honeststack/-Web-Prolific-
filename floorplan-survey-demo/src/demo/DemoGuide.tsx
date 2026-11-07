import { useEffect, useState } from "react";
import { ParticipantState } from "../../shared/types";
import { SurveyParams } from "../participant/Survey";
import { GUIDE, REASON_LABEL } from "./guide-content";

interface Tools {
  toAttentionFromHere: () => Promise<void>;
  toEndOfMain: () => Promise<void>;
  pass: () => Promise<void>;
  finishSurvey: () => Promise<void>;
}

interface Props {
  state: ParticipantState;
  left: boolean;
  busy: boolean;
  tools: Tools;
  params: SurveyParams;
  onBackTest: () => void;
}

export function DemoGuide({ state, left, busy, tools, params, onBackTest }: Props) {
  const [open, setOpen] = useState(window.innerWidth >= 1200);
  // On wide screens the panel takes its own column, so it never covers the answer area.
  useEffect(() => {
    const update = () => document.documentElement.classList.toggle("guide-docked", open && window.innerWidth >= 1100);
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      document.documentElement.classList.remove("guide-docked");
    };
  }, [open]);
  const trial = state.trial;
  const key = left ? "left" : trial?.kind === "attention" ? "attention" : state.stage;
  const entry = GUIDE[key];
  const before = ["consent", "instructions", "comprehension"].includes(state.stage);
  const inTrials = state.stage === "main" || state.stage === "practice";
  const after = state.stage.startsWith("post_") || state.stage === "demographics";
  const shownAsLeft = trial?.demo?.leftRole === "b";

  return (
    <div lang="ja" className={`guide ${open ? "is-open" : ""}`}>
      <button className="guide-tab" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? "解説を閉じる" : "デモ解説"}
      </button>
      {open && (
        <aside className="guide-panel" aria-label="デモ解説">
          <p className="guide-kicker">デモ解説（参加者には表示されません）</p>
          {entry && (
            <>
              <h2>{entry.title}</h2>
              <p className="guide-req">{entry.requirement}</p>
              <ul>
                {entry.points.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </>
          )}

          {trial?.demo && !left && (
            <dl className="guide-meta">
              <dt>問題ID</dt>
              <dd>{trial.demo.tripletId}</dd>
              <dt>抽出条件</dt>
              <dd>{trial.demo.condition}</dd>
              {trial.kind === "main" && (
                <>
                  <dt>選択の根拠</dt>
                  <dd>{REASON_LABEL[trial.demo.reason] ?? trial.demo.reason}</dd>
                  <dt>割当時の負荷</dt>
                  <dd>
                    この問題 {trial.demo.loadBefore ?? "-"} / 全体の最小 {trial.demo.minLoad ?? "-"}
                  </dd>
                </>
              )}
              <dt>左右</dt>
              <dd>{shownAsLeft ? "左=b画像 / 右=c画像" : "左=c画像 / 右=b画像"}</dd>
              {trial.demo.expected && (
                <>
                  <dt>正解</dt>
                  <dd>Floor plan {trial.demo.expected}</dd>
                </>
              )}
            </dl>
          )}

          <div className="guide-tools">
            <p className="guide-kicker">デモ操作</p>
            {before && (
              <button className="button tool" disabled={busy} onClick={() => void tools.pass()}>
                練習まで進める
              </button>
            )}
            {inTrials && (
              <>
                <button className="button tool" disabled={busy} onClick={() => void tools.toAttentionFromHere()}>
                  次の注意力確認まで自動回答
                </button>
                <button className="button tool" disabled={busy} onClick={() => void tools.toEndOfMain()}>
                  本試行の最後まで自動回答
                </button>
                <button className="button tool" disabled={busy || left} onClick={onBackTest}>
                  ブラウザの「戻る」を試す
                </button>
              </>
            )}
            {after && (
              <button className="button tool" disabled={busy} onClick={() => void tools.finishSurvey()}>
                事後・属性質問を自動入力して完了
              </button>
            )}
            <button className="button tool" onClick={() => window.location.reload()}>
              同じURLを開き直す
            </button>
            <a className="button tool" href="/admin" target="_blank" rel="noreferrer">
              管理画面を別タブで開く
            </a>
            <a className="button tool" href="/">
              デモのトップへ
            </a>
            <p className="guide-foot">
              参加者ID <code>{params.pid}</code>
              <br />
              自動回答は実際のAPIを通り、CSVに autofilled=1 と記録されます。
            </p>
          </div>
        </aside>
      )}
    </div>
  );
}
