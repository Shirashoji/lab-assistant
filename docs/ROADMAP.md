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
- [x] `bin/search.mjs` CLI(`--source` / `--since` / `--until` / `--sort` / `--limit` /
      `--channels` / `--max-channels` / `--text`)
- [x] `check-setup.mjs` に横断検索の準備状況を表示
- 既知の制約: Discord は Bot に閲覧権限のあるチャンネルのみ。学科の重要チャンネル
  (週報・ゼミアナウンス等)は Bot ロールへの権限付与が必要。期間未指定だと各チャンネル
  直近 100 件のみ。全文インデックスは無いので大規模検索は `--since` 前提。

### Phase 2 — Slack 連携
- [ ] Slack App 作成手順を README に追加(必要スコープ: `search:read` 等)
- [ ] `scripts/lib/slack.mjs` + `bin` ラッパー

### Phase 3 — スキル
- [ ] `skills/find-schedule/`
- [ ] `skills/check-shared/`(週報 Visualization 重複チェック含む)
- [ ] `skills/find-channel/`
- [ ] `skills/search-lab/`
- [ ] `add-event` をゼミカレンダー前提に更新

### Phase 4 — Google Drive / GitHub
- [ ] Drive: 公式 MCP or Drive API での資料検索
- [ ] GitHub: Issue / コード / README 検索

### Phase 5 — 配布
- [ ] `mcp-server` に検索ツールを追加
- [ ] `Agent-Plugins` マーケットプレイスに `lab-assistant` を登録
- [ ] `install.mjs` を汎用化

## 未決事項

- Drive / GitHub は公式 MCP を使うか自前実装か(依存ゼロ原則との兼ね合い)。
- Slack は学科ワークスペースの管理者権限が必要(App 承認)。誰に依頼するか。
- `search-vdslab/`(先行の叩き台、未検証)は参照用に残置。使える部分があれば取り込む。
