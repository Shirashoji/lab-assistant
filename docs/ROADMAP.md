# lab-assistant ロードマップ

`Calendar-agent`(Discord/esa の URL → Google Calendar 予定作成)を土台に、研究室の情報基盤を
**横断検索・調査**できる汎用エージェントへ発展させる。

## 背景 / 出発点

- `Calendar-agent` から fork(履歴を引き継いでクローン)。
- 継承する資産:
  - `scripts/lib/` … 依存ゼロの Node コアロジック(`collect` / `dedupe` / `discord` / `esa` / `gcal` / `url` / `config`)
  - `scripts/bin/` … その薄い CLI ラッパー + `auth-google.mjs` / `check-setup.mjs` / `list-calendars.mjs`
  - `skills/add-event/` … URL → 予定作成スキル(返信/スレッド/分割メッセージ/重複チェック対応)
  - `bot/` … 任意の Discord Bot、`mcp-server/` … 任意の MCP サーバー(stdio + HTTP)
  - `scripts/install.mjs` … claude-desktop / claude-code / chatgpt へのインストーラ

## 目指す姿

「M2 の中間報告会っていつ?」のような問いに対し、それが Discord にあるのか Slack にあるのか
esa にあるのか分からなくても、横断的に探して答える。イベントであれば **ゼミの Google Calendar に
入っているか確認し、無ければ追加を提案** する。

## データソース

| ソース | 用途 | 取得方法(案) |
| --- | --- | --- |
| Discord | 連絡・アナウンス・議論 | 既存 `scripts/lib/discord.mjs` を検索対応に拡張(Bot Token) |
| Slack(学科) | 連絡・アナウンス | 新規 `scripts/lib/slack.mjs`(Bot Token / `search.messages`) |
| esa | 議事録・ドキュメント | 既存 `scripts/lib/esa.mjs` に検索(`/v1/teams/{team}/posts?q=`)を追加 |
| Google Calendar(ゼミ) | 確定した予定 | 既存 `scripts/lib/gcal.mjs` に `listEvents`/検索。**ゼミ用カレンダーを既定に** |
| Google Drive | 資料・スライド | 公式 MCP もしくは Drive API(`files.list` full-text) |
| GitHub | コード・Issue・Wiki | 公式 MCP もしくは REST search |

## 主要ユースケース(スキル候補)

1. **`find-schedule`** — 「次のゼミ/中間報告会/発表会はいつ?」
   Google Calendar(ゼミ)を最優先 → esa 議事録 → Discord/Slack の直近アナウンスの順で照合。
   矛盾があれば新しい方を提示。未来の予定のみ回答。
   → カレンダーに無ければ「追加しますか?」と確認して `add-event` の作成処理へ。
2. **`check-shared`** — 「この記事/Visualization はもう共有された?」
   esa / Discord / Slack を横断検索。**週報の面白い Visualization 紹介で、過去に自分が
   紹介済みでないかのチェック**を含む(自分の発言・共有履歴を対象に)。
3. **`find-channel`** — 「◯◯について話しているチャンネルはどこ?」
   Discord/Slack のチャンネルを話題から特定。
4. **`search-lab`** — 汎用横断検索。トピックを与えて全ソースを検索し出典付きで要約。
5. **`add-event`**(継承) — URL や本文から予定を抽出 → 重複チェック → ゼミカレンダーへ作成。

## アーキテクチャ方針(2026-08-30 更新)

- **公式 MCP がある情報源はその MCP をバンドルする**。プラグインルートの `.mcp.json` に宣言すると
  Claude Code が `plugin:lab-assistant:<server>` として自動登録する。
  認証情報は `scripts/bin/<svc>-mcp.mjs` の起動ラッパで `.env` から注入し、一元管理を保つ。
  - esa … `@esaio/esa-mcp-server`(実装済み)
  - Slack … 公式 `mcp.slack.com`(管理者承認が必要。下記)
  - GitHub / Google Drive … 公式 MCP(Phase 4)
- **公式 MCP が無い / 精密制御が要るものは `scripts/` の依存ゼロ Node で実装する**。
  - Discord 検索(Bot は検索 API 不可)… `lib/discord.mjs` + `bin/search.mjs`
  - ゼミカレンダーの予定確認・作成・重複判定 … `lib/gcal.mjs` / `lib/dedupe.mjs`
- **スキルが両者を順に呼んで結果を統合する**。横断検索オーケストレータをコードに持たせない
  (`lib/search.mjs` は Calendar + Discord のみの薄い実行器に縮小した)。

## Google Calendar の扱い(重要)

- ゼミ用の Google Calendar MCP と、Claude アプリ標準の Google Calendar MCP の **2 つが共存** している。
  予定の確認・追加は必ず **ゼミ用** が使われるようにする。
- 対策(いずれか / 併用):
  - 予定操作はプラグイン同梱の `scripts/lib/gcal.mjs`(専用 OAuth + `GOOGLE_CALENDAR_ID` = ゼミ)経由に統一し、
    汎用 Calendar MCP は使わないとスキル手順に明記する。
  - `check-setup.mjs` で対象カレンダーが「尾上ゼミ ミーティング」で writer/owner であることを検証。
- 予定を探すときのルール:「まずゼミ Google Calendar を確認 → 無ければユーザーに追加可否を確認 → 承認後に追加」。

## スキル設計方針

- 複数機能が乗るので、各スキルは **明確な手順(番号付き)** と **停止条件 / 確認ポイント** を持つ。
- 横断検索系は「どのソースを見たか」を必ず回答に含める(見つからなかった場合も)。
- 副作用(カレンダー書き込み、メッセージ送信)は必ず事前確認。
- 出典(URL / permalink / チャンネル名 / 著者 / 日時)を必ず添える。
- ルーティング用の親スキル or `search-lab` を入口にし、そこから個別スキルへ振り分けることも検討。

## フェーズ

### Phase 0 — リポジトリ整備
- [x] `Calendar-agent` を fork → `lab-assistant`(履歴引き継ぎクローン、`origin` は削除済み)
- [x] `.claude-plugin/plugin.json` / README の刷新
- [x] GitHub Flow の運用ドキュメント(`docs/DEVELOPMENT.md`, PR テンプレート)
- [x] ロードマップ(本ファイル)
- [x] 検索系スキルの下書き(`skills/find-schedule/`, `skills/check-shared/`)
- [x] `chore/rename-internals` — コード内の識別子を `calendar-agent` → `lab-assistant` に統一
      (`scripts/install.mjs` の MCP サーバー名 / marketplace 参照、`mcp-server/` 各所、
      User-Agent 文字列、`check-setup.mjs` のログ)
- [ ] GitHub にリモートリポジトリを作成して push(ユーザー操作)

### Phase 1 — 検索基盤 ✅ (feat/search-core)
- [x] `scripts/lib/search.mjs` … 共通の検索結果型(source / title / url / snippet / author / timestamp / extra)+ オーケストレータ `searchAll`
- [x] `scripts/lib/text.mjs` … 検索用テキストユーティリティ(正規化 / トークナイズ / 抜粋)
- [x] `esa.mjs` に全文検索 `searchPosts` を追加(要 `ESA_DEFAULT_TEAM`)
- [x] `discord.mjs` にチャンネル横断検索 `searchMessages` を追加
      (Bot は検索 API 不可のため直近メッセージを取得しクライアント側でフィルタ。
      スノーフレークで活動期間を判定 → 活動の新しい順に maxChannels まで → 並列取得)
- [x] `gcal.mjs` に `searchEvents`(期間 + キーワード)を追加
- [x] `bin/search.mjs` CLI
- [x] `check-setup.mjs` に横断検索の準備状況を表示
- [x] **方針転換**: esa 検索は自前 `searchPosts` をやめ、esa 公式 MCP に置換(下記 Phase 1.5)。
      `lib/search.mjs` は Calendar + Discord のみに縮小。
- 既知の制約: Discord は Bot に閲覧権限のあるチャンネルのみ。学科の重要チャンネル
  (週報・ゼミアナウンス等)は Bot ロールへの権限付与が必要。期間未指定だと各チャンネル
  直近 100 件のみ。全文インデックスは無いので大規模検索は `--since` 前提。

### Phase 1.5 — esa 公式 MCP のバンドル ✅ (feat/esa-mcp)
- [x] `.mcp.json` に `esa` サーバーを宣言
- [x] `scripts/bin/esa-mcp.mjs` … `.env` の `ESA_ACCESS_TOKEN` を注入して `@esaio/esa-mcp-server` を起動
- [x] `lib/esa.mjs` から `searchPosts` を削除(`getPost` / `getUser` は残す)
- [x] `lib/search.mjs` / `bin/search.mjs` / `check-setup.mjs` から esa を除去
- [x] README にバンドル MCP と Slack の説明を追加
- 検証: MCP wrapper 経由で `initialize` / `tools/list` / `esa_search_posts` が動作(esa-mcp-server v0.14.0)

### Phase 2 — Slack 連携 ✅ (feat/slack-search)
- 判断: 公式 MCP はワークスペース管理者の承認が必要 → **自前アプリ + ユーザートークン方式**を採用
- [x] `slack-app/` — `search:read` だけの最小アプリ(manifest + Slack CLI フック)。
      `slack app install` で学科ワークスペースにインストール(**管理者承認は不要だった**)
- [x] `scripts/lib/slack.mjs` — `search.messages`(ユーザートークン)→ 共通ヒット形
- [x] `scripts/lib/config.mjs` — `slackUserToken` / `.env` の `SLACK_USER_TOKEN`
- [x] `lib/search.mjs` / `bin/search.mjs` に `slack` ソースを追加(既定ソースに含む)
- [x] `check-setup.mjs` に Slack 疎通チェック(任意機能なので合否には含めない)
- 検証: 実データで「M2 中間報告会」→ #2025-大学院 の M2 中間発表会アナウンス(9/11-12)がヒット
- 制約: 検索範囲はトークン所有者が見えるチャンネルのみ。全文インデックスは Slack 側にあるので Discord より高速。
- 補足: 公式 Slack MCP に移行したくなったら `.mcp.json` に `slack`(`type: sse`, `https://mcp.slack.com/sse`)を
  足して `lib/slack.mjs` を落とすだけ。ただしそのときは管理者承認が必要。

### Phase 3 — スキル ✅ (feat/phase3-skills)
- [x] `skills/find-schedule/` — Calendar(ゼミ)→ esa MCP → Slack/Discord の順で照合、
      未来の予定を出典付きで回答、ゼミカレンダー未登録なら add-event に橋渡し
- [x] `skills/check-shared/` — esa / Slack / Discord を横断、週報 Visualization の自己重複チェック含む
- [x] `skills/find-channel/` — 話題 → チャンネル特定(ヒットを channelName で集計)
- [x] `skills/search-lab/` — 調べもの全般の入口。振り分け + 横断検索 + 出典付き要約
- [x] `add-event` — 作成先が **ゼミ Google Calendar**(自前 OAuth)であることを明記
- 各スキル共通: 「見たソース・期間・カバレッジ・スキップを必ず明記」「副作用は事前確認」
- 検証: find-schedule の各ステップを実データで実行、「M2 中間報告会」で Slack の発表会アナウンス
      (9/11-12)と esa の先生 MTG 議事録が取れることを確認

### Phase 4 — Google Drive / GitHub
- [ ] Drive: 公式 MCP or Drive API での資料検索
- [ ] GitHub: Issue / コード / README 検索

### Phase 5 — 配布
- [ ] `mcp-server` に検索ツールを追加
- [ ] `Agent-Plugins` マーケットプレイスに `lab-assistant` を登録
- [ ] `install.mjs` を汎用化

## 未決事項

- Drive / GitHub は公式 MCP を使う想定(esa と同じくバンドル + 起動ラッパ)。
- Slack: 自前アプリ + ユーザートークン方式で実装済み(管理者承認は不要だった / 2026-08-30)。
  トークン失効時は slack-app を再インストールして `SLACK_USER_TOKEN` を差し替える。
  重複アプリ `A0BTQ73GE57`(`--environment local` で試した残骸)は `slack app delete` で掃除可。
- `search-vdslab/`(先行の叩き台、未検証)は参照用に残置。使える部分があれば取り込む。
- `mcp-server/`(ChatGPT/Codex 向け)は esa/Slack MCP をカバーしない。ChatGPT パスの扱いは Phase 5 で再検討。
