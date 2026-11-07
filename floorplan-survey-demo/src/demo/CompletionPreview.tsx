export function CompletionPreview() {
  const code = new URLSearchParams(window.location.search).get("cc") ?? "-";
  return (
    <div className="hub">
      <main className="hub-main narrow">
        <p className="hub-kicker">デモ用の模擬ページ</p>
        <h1>完了URLへの遷移を確認しました</h1>
        <p>本番では、ここがProlificの完了URLになり、参加者の提出が完了として記録されます。遷移先は管理画面の設定から変更できます。</p>
        <dl className="kv">
          <dt>完了コード（デモ）</dt>
          <dd>
            <code>{code}</code>
          </dd>
        </dl>
        <p>
          <a className="button primary" href="/">
            デモのトップへ戻る
          </a>{" "}
          <a className="button secondary" href="/admin">
            管理画面で記録を確認
          </a>
        </p>
      </main>
    </div>
  );
}
