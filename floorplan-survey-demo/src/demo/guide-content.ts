/** Presenter notes shown in the demo guide panel, per screen. Never rendered for real participants. */
export interface GuideEntry {
  title: string;
  requirement: string;
  points: string[];
}

export const GUIDE: Record<string, GuideEntry> = {
  consent: {
    title: "同意・説明",
    requirement: "画面遷移 p.1 / 全画面保存",
    points: [
      "Prolificから渡されたPID・Study ID・Session IDは、URLから取得済みです。この時点で参加者レコードが作られます。",
      "同意／不同意も回答と同じ形式で保存し、CSVに出力します。",
      "「I do not agree」の遷移先は資料に画面がないため、仮の終了画面を用意しました。文面はご確認ください。",
    ],
  },
  instructions: {
    title: "間取り図の読み方",
    requirement: "画面遷移 p.2",
    points: [
      "資料では説明画面のボタンが「Submit answer」でしたが、回答がない画面のため「Continue」に修正しています。",
      "例示画像はダミーです。実データの画像に差し替えます。",
    ],
  },
  comprehension: {
    title: "理解度確認",
    requirement: "画面遷移 p.3〜5 / 2回失敗で終了",
    points: [
      "正解判定はサーバー側で行います。ブラウザに正解データは送りません。",
      "各回の回答と合否を保存します。1回目の不正解で再挑戦画面、2回目の不正解で終了画面に分岐します。",
      "2回失敗した参加者が再アクセスしても終了画面のままです。アクセスは拒否せず、再受験だけを防ぎます（ご確認事項）。",
    ],
  },
  practice: {
    title: "練習",
    requirement: "画面遷移 p.6 / 本試行と区別して保存",
    points: [
      "回答は row_type=practice として保存し、割り当てカウントには一切影響しません。",
      "練習問題は別途ご提供の予定のため、現在は仮の2問です。問題数は差し替え時に調整できます。",
    ],
  },
  main: {
    title: "本試行",
    requirement: "機能1・3・4",
    points: [
      "問題は開始時にまとめて確保せず、1問ごとにその時点で最も回答数が少ない問題から割り当てます。離脱しても確保されたまま残る問題は最大1問です。",
      "「次へ」を押すと、回答の保存を確認してから次の問題を表示します。通信エラー時は自動で再送し、再送しても二重に数えません。",
      "回答時間は3枚すべての描画が完了した時点から計測します。そのため3枚が揃うまで画像は表示せず、回答もできません。",
      "画像は余白を切らず縦横比を保ち、3枚とも同じ大きさで表示します。ブラウザの幅と高さに合わせて調整されます。",
    ],
  },
  attention: {
    title: "注意力確認",
    requirement: "画面遷移 p.10・14 / 42問中の16問目・31問目",
    points: [
      "位置はNに連動します（N=40で16問目と31問目）。回答数の均等化の対象外です。",
      "正解はサーバーだけが持っています（本番ではブラウザに送りません。右の「正解」欄はデモ表示です）。",
      "不合格時の扱いは資料に定めがないため、現在は記録のみとしています。管理画面で「回答数カウントから除外」も選べます（ご確認事項）。",
    ],
  },
  post_aspects: {
    title: "事後質問：考慮した観点",
    requirement: "画面遷移 p.18 / 最低1つ選択",
    points: ["資料で「Position of entrance and corridors」が重複していたため、1つにまとめています。正しい選択肢をご確認ください。", "Otherを選ぶと記述欄が開き、未記入では進めません。"],
  },
  post_most: {
    title: "事後質問：最も重視した観点",
    requirement: "画面遷移 p.19",
    points: ["前の設問で選んだ項目だけを表示し、Otherには前問の記述を引き継ぎます。スライドのノートの指示どおりです。"],
  },
  post_difficulty: { title: "事後質問：難しさ", requirement: "画面遷移 p.20", points: ["5段階の単一選択です。"] },
  post_comments: { title: "事後質問：自由記述", requirement: "画面遷移 p.21", points: ["任意回答です。CSV出力時はExcelの数式として実行されないよう無害化します。"] },
  demographics: {
    title: "属性質問",
    requirement: "画面遷移 p.22 / 必須6問",
    points: ["未回答が残っている間は送信できません。", "送信の保存が確認できて初めて、完了扱いになります。"],
  },
  complete: {
    title: "完了・Prolificへの遷移",
    requirement: "機能5",
    points: [
      "資料は「ボタン」、依頼文は「自動リダイレクト」となっていたため、両方に対応しました（秒数は管理画面で設定、0でボタンのみ）。",
      "完了URLは管理画面から変更できます。デモでは模擬ページに遷移します。",
      "同じURLで開き直しても再回答できません。下の「同じURLを開き直す」でお見せできます。",
    ],
  },
  ended_comprehension: { title: "理解度確認で終了", requirement: "画面遷移 p.5", points: ["再アクセスしてもこの画面のままです。下の「同じURLを開き直す」で確認できます。"] },
  ended_declined: { title: "不同意で終了", requirement: "資料に画面なし（仮）", points: ["同意画面に戻って再検討できるよう、再アクセス時は同意画面から再開します。"] },
  left: {
    title: "ブラウザの戻る操作",
    requirement: "依頼文：戻る操作は途中離脱として扱う",
    points: [
      "表示中の問題はこの瞬間に解放され、他の参加者に割り当てられます。保存済みの回答はそのままです。",
      "未完了者の再アクセスは拒否しない要件なので、戻ると残りの問題数ぶん、未出題の問題から再開します。",
    ],
  },
};

export const REASON_LABEL: Record<string, string> = {
  planned: "計画どおりの条件",
  balance_override: "均等化を優先して条件を変更",
  anchor_relaxed: "基準Aの重複を許容",
  last_resort: "残りの問題から選択",
  fixed: "固定問題",
};
