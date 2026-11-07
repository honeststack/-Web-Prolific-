# 間取り図の類似性評価アンケート（提案用デモ）

Prolificと連携するWebアンケートのデモです。React + Netlify Functions + Netlify Blobs で動きます。問題データと間取り図はダミーです。

デモの進め方と説明内容は [docs/デモ説明ガイド.md](docs/デモ説明ガイド.md) を参照してください。

## Netlifyへの配置

**Functionsとデータ保存を使うため、ドラッグ＆ドロップ（Netlify Drop）では動きません。** 次のどちらかで配置します。

### 方法A：Netlify CLI

このフォルダで実行します。

```bash
npm install
npx netlify-cli login
npx netlify-cli init                 # 新しいサイトを作成
npx netlify-cli deploy --build --prod
```

### 方法B：Gitリポジトリ連携

このフォルダをリポジトリのルートとしてGitHubなどへpushし、Netlifyの「Add new site」から接続します。ビルド設定は `netlify.toml` から自動で読み込まれます。

### 環境変数（任意）

| 変数 | 内容 | 既定 |
|---|---|---|
| `ADMIN_PASSWORD` | 管理画面のパスワード | 未設定なら `demo-admin` で、デモ画面に表示され自動ログインします |
| `DEMO_MODE` | `false` でデモ機能を無効化（`ADMIN_PASSWORD` が必須になります） | デモ機能は有効 |

`ADMIN_PASSWORD` が未設定の場合、URLを知っている人は誰でも管理画面を操作でき、データも削除できます。

### 配置後の確認

サイトを開くか、ローカルから次を実行します。

```bash
ADMIN_PASSWORD=（設定した値） npm run loadtest -- https://（サイト名）.netlify.app --participants 20 --questions 6
```

最後に `RESULT: OK` と表示されれば合格です。管理画面の「動作試験」タブでも同じ試験ができます。試験のデータは「調査設定」タブの全削除で消せます。

## ローカルで動かす

```bash
npm install
npm run build
npm run preview        # http://localhost:8787
```

開発時は `npm run dev` です（http://localhost:5173）。データは `.data/` に保存されます。

## テスト

| コマンド | 内容 |
|---|---|
| `npm test` | 割り当て、保存、離脱、CSV、取り込み、Blobsアダプター |
| `npm run e2e -- http://localhost:8787 出力先` | 実ブラウザで全画面を操作。空のデータで実行（初回は `npx playwright install chromium`） |
| `npm run verify:function` | Functionをバンドルし、本番と同じ設定経路で動作確認 |
| `npm run loadtest -- URL` | 稼働中のサイトへの同時アクセス試験 |
| `npx tsx scripts/simulation-report.ts` | 説明ガイドに記載のシミュレーション数値を出力 |

## 実データの取り込み

```bash
npm run import -- --zip RPLAN.zip              # 検証のみ
npm run import -- --zip RPLAN.zip --apply      # 検証に通れば置き換え
```

ZIPの代わりに `--csv triplets.csv --images RPLAN_triplets` も指定できます。置き換え後は、ビルド時に `KEEP_CLIENT_DATA=1` を設定し、`.gitignore` の `public/RPLAN_triplets/` を外してください。

## 構成

| 場所 | 役割 |
|---|---|
| `shared/allocator.ts` | 割り当てロジック本体（API、テスト、シミュレーターで共通） |
| `server/service.ts` | 調査の進行、保存、離脱、管理機能 |
| `server/store.ts`, `server/netlify-store.ts` | データ保存層（条件付き書き込み） |
| `netlify/functions/api.ts` | Netlify Functionの入口 |
| `src/participant/` | 参加者画面（英語） |
| `src/admin/` | 管理画面（日本語） |
| `src/demo/` | デモ用トップ、解説パネル |
| `shared/content.ts` | 参加者向けの文言と選択肢 |
| `scripts/` | データ生成、取り込み検証、試験ツール |
