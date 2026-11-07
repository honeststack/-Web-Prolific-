import { useEffect, useState } from "react";
import { ApiInfo, getInfo } from "../api";

function randomId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function participantUrl(extra = "") {
  const pid = randomId("DEMO");
  return `/?PROLIFIC_PID=${pid}&STUDY_ID=DEMO_STUDY&SESSION_ID=${randomId("SES")}&demo=1${extra}`;
}

const TOUR = [
  { title: "参加者の全フローを体験", text: "同意から完了まで、資料どおりの全画面を実際に操作します。各画面の要点は右の解説パネルに表示されます。", href: "__participant", cta: "参加者として開始" },
  { title: "均等化と条件比率を検証", text: "仮想参加者1,000人の調査を再現し、単純ランダム割り当てと比較します。依頼文で特に説明を求められている点です。", href: "/admin?tab=simulation", cta: "シミュレーションを開く" },
  { title: "収集状況と管理操作を確認", text: "問題別の回答数、CSV出力、一時停止・再開、完了URLや出題数の設定をご覧いただけます。", href: "/admin", cta: "管理画面を開く" },
  { title: "同時アクセスを実地で試験", text: "実際のサーバーに仮想参加者を同時に接続し、競合や重複が起きないことをその場で確認します。", href: "/admin?tab=tests", cta: "試験画面を開く" },
];

const SCENARIOS = [
  { title: "画像エラーからの復旧", text: "表示できない画像を意図的に発生させ、別の問題への差し替えと管理画面への記録を確認します。", href: "__failImage" },
  { title: "取り込み時の欠損・破損検出", text: "意図的に壊したサンプルで、検出できる不備の種類を確認します。", href: "/admin?tab=data" },
];

export function Hub() {
  const [info, setInfo] = useState<ApiInfo | null>(null);
  const [apiDown, setApiDown] = useState(false);

  useEffect(() => {
    getInfo()
      .then(setInfo)
      .catch(() => setApiDown(true));
  }, []);

  const resolve = (href: string) => (href === "__participant" ? participantUrl() : href === "__failImage" ? participantUrl("&failImage=1") : href);

  if (info && !info.demoMode) {
    return (
      <div className="hub">
        <main className="hub-main">
          <h1>このページはProlificからアクセスしてください。</h1>
        </main>
      </div>
    );
  }

  return (
    <div className="hub">
      <header className="hub-hero">
        <p className="hub-kicker">ご提案用デモ</p>
        <h1>間取り図の類似性評価アンケート</h1>
        <p className="hub-lead">Prolificから参加した方に3枚の間取り図を比較していただき、回答を問題ごとに確実に保存して、回答数を均等に集めるWebシステムです。</p>
        <div className="hub-facts">
          <div>
            <strong>3,000</strong>
            <span>問題データ（ダミー）</span>
          </div>
          <div>
            <strong>42</strong>
            <span>本試行40問＋注意力確認2問</span>
          </div>
          <div>
            <strong>2 : 1 : 1 : 2 : 1 : 1 : 2</strong>
            <span>抽出条件 a〜g の出題比率</span>
          </div>
        </div>
      </header>

      <main className="hub-main">
        {apiDown && (
          <p className="notice" role="alert">
            サーバーに接続できません。Netlifyへの配置方法をご確認ください（Functionsが動く方法での配置が必要です）。
          </p>
        )}
        <h2>デモの見どころ</h2>
        <ol className="tour">
          {TOUR.map((step, i) => (
            <li key={step.title}>
              <span className="tour-no">{i + 1}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </div>
              <a className={`button ${i === 0 ? "primary" : "secondary"}`} href={resolve(step.href)}>
                {step.cta}
              </a>
            </li>
          ))}
        </ol>

        <h2>個別に確認する</h2>
        <div className="scenario-grid">
          {SCENARIOS.map((s) => (
            <a className="scenario" key={s.title} href={resolve(s.href)}>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </a>
          ))}
        </div>

        <h2>このデモについて</h2>
        <ul className="plain-list">
          <li>間取り図と問題データは動作確認用に自動生成したダミーです。実際のデータは取り込み検証を経て差し替えます。</li>
          <li>Prolificとの接続は、URLパラメータと完了URLへの遷移を模擬環境で確認しています。実際のStudyでの確認はパイロット前に行います。</li>
          <li>入力したデータはデモ環境に保存されます。個人情報は入力しないでください。</li>
        </ul>
      </main>
    </div>
  );
}
