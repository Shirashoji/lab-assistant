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

## Google Calendar の扱い(重要)— Phase C で対応済み

- ゼミ用の Google Calendar と、Claude アプリ標準の Google Calendar コネクタの **2 つが共存**。
  予定の確認・追加は必ず **ゼミ用** に向ける必要がある。
- 対応(Phase C, `feat/seminar-calendar-mcp`):
  - `.mcp.json` に **`seminar-calendar`** サーバーを宣言(`scripts/bin/seminar-calendar-mcp.mjs`、
    依存ゼロ stdio MCP、`scripts/lib/mcp-stdio.mjs` の自作ヘルパを使用)。
    全ツールが `.env` の `GOOGLE_CALENDAR_ID` に固定される。
  - ツール: `list_events` / `search_events` / `find_duplicate_events` / `create_event` / `list_calendars`。
  - スキル(`find-schedule` / `add-event`)は `plugin:lab-assistant:seminar-calendar` のツールを
    第一に使い、「標準 Calendar コネクタは使わない」と明記。`bin/*.mjs` は bot / ChatGPT 用フォールバック。
  - `check-setup.mjs` が対象カレンダー(「尾上ゼミ ミーティング」/ owner)とバンドル MCP の状態を表示。
- 予定を探すルール:「まずゼミ Calendar を確認 → 無ければ追加可否をユーザーに確認 → 承認後に作成」。

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
- ⚠ **この「置換」は Phase 6 で撤回した**(下記)。MCP が使えないセッション
  (ChatGPT / Codex / Bot / MCP 未接続)で esa だけ検索できなくなる、という実害が出たため。
  現在は「`search.mjs` が API を直接叩く(既定)+ MCP も併存」の形。

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

### Phase C — ゼミカレンダー専用 MCP ✅ (feat/seminar-calendar-mcp)
- [x] `scripts/lib/mcp-stdio.mjs` — 依存ゼロの最小 MCP サーバー(改行区切り JSON-RPC)ヘルパ。
      在フライトのリクエストを待ってから終了する
- [x] `scripts/bin/seminar-calendar-mcp.mjs` — `lib/gcal.mjs` / `lib/dedupe.mjs` をラップした
      ゼミカレンダー固定の MCP。ツール 5 種
- [x] `.mcp.json` に `seminar-calendar` を追加
- [x] `check-setup.mjs` にバンドル MCP(esa + seminar-calendar)の状態表示
- [x] `skills/find-schedule` / `skills/add-event` を `seminar-calendar` MCP 優先に更新
- 検証: `initialize` / `tools/list` / `list_calendars`(target=尾上ゼミ, owner) /
      `search_events`(週報 16 件) / `find_duplicate_events`(likelyMatch 検出)を実データで確認

### Phase 4 — Google Drive / GitHub ✅ (feat/github-search, feat/drive-search)
判断: どちらも公式 MCP ではなく **依存ゼロの自前実装**にした。GitHub の公式 MCP は
Docker / リモート前提で `.env` 一元管理と噛み合わず、Drive は Calendar と同じ OAuth を
そのまま使い回せるため。共通ヒット形に載せられるので `search.mjs` / `find-expert.mjs` から
そのまま使える。
- [x] GitHub: `lib/github.mjs` — `/search/{issues,code,commits,repositories}`。
      `GITHUB_TOKEN` + `GITHUB_ORGS` / `GITHUB_REPOS` でスコープする。
      制約: code 検索は期間指定不可・author/timestamp が取れない、discussions は未対応
      (GraphQL が要る)、Search API は 30 req/min。
- [x] Drive: `lib/gdrive.mjs` — `files.list` の `fullText contains`。共有ドライブ込み
      (`corpora=allDrives`)。**`auth-google.mjs` に `drive.readonly` を追加したので
      リフレッシュトークンの取り直しが必要**。未許可時はその旨を日本語で案内する。
- [x] **追補**: `.env` の `DRIVE_ID` (または `--drive`) で研究室の共有ドライブ 1 つに絞れる
      (`corpora=drive&driveId=...`、配下フォルダも再帰的に対象)。ID は
      `bin/list-drives.mjs` (`drives.list`) で確認。未設定時は従来どおり `allDrives`。
      `DRIVE_FOLDER_IDS` は `in parents` なので直下のみ (再帰しない) 点に注意。
- [x] **追補**: `bin/drive-fetch.mjs` — Drive の資料をローカルに落として Read で読む
      (Docs→text / Sheets→CSV / Slides→PDF / それ以外は alt=media でそのまま)。
      `getFileText` が PDF・Office を扱えない穴を埋めるためのもの。
- [x] `lib/search.mjs` の `AVAILABLE_SOURCES` は `calendar,slack,discord,github,drive` に。
- [x] **追補 (feat/github-discussions)**: Discussions を GraphQL (`search(type: DISCUSSION)`) で対応し、
      「未対応」警告を削除。あわせて code ヒットの author / timestamp を最新コミットから補う
      `enrichCode` を追加 (先頭 10 件のみ・repo+path でメモ化)。find-expert では既定で有効
      (`--no-enrich-code` で無効化)。code のヒットが「誰が詳しいか」の根拠として使えるようになった。
      検証: vercel/next.js の "app router" で Discussions 3523 件中 3 件、
      vdslab の "d3" code 4 件すべてに著者と日付が入ることを確認。
      (vdslab org は Discussions 未使用のため 0 件になるのが正常)
- 検証: GitHub は `GITHUB_ORGS=vdslab` で "可視化" → theme2026-kaziru の PR/Issue が取れた。
  Drive はスコープ未許可の状態で再認証案内が出ることまで確認 (実データ検索は再認証後)。

### Phase 4.5 — find-expert ✅ (feat/find-expert)
「◯◯に詳しい人は?」に答えるスキル。横断検索のヒットを**人物ごとに畳み込む**。
- [x] `lib/experts.mjs` — `aggregateExperts`。ソース重み × 鮮度 (半減期 365 日) ×
      検索語の濃さ + 複数ソース出現ボーナス。名寄せ (`identityKey` / alias) と Bot 除外。
- [x] `bin/find-expert.mjs` — CLI。`--extra-hits` で esa MCP の結果を混ぜられる。
- [x] `lib/slack.mjs` に `resolveUserName(s)` — `search.messages` が返す生 ID を表示名に。
      `users:read` が無ければ黙って ID のまま。
- [x] `skills/find-expert/` — score を鵜呑みにせず evidence を読むこと、
      人物評価は「観測事実」として書くことを明記。
- 検証: "MCP" で Discord/Slack から候補 + 根拠リンクを取得。Bot (GitHub 連携) が除外され、
  Slack の生 ID が表示名に解決されることを確認。

### Phase 5 — 配布
- [x] `mcp-server` に検索ツールを追加 — `search_lab` / `find_expert` / `list_search_sources`。
      `find_expert` は `extraHits` で esa MCP の結果を受け取れる。
- [x] `install.mjs claude-desktop` がバンドル MCP も登録するように
      (`lab-assistant-esa` / `lab-assistant-seminar-calendar`)。
      `esa-mcp.mjs` は GUI アプリ起動時に PATH が無くても npx を解決できるようにした。
- [ ] `Agent-Plugins` マーケットプレイスに `lab-assistant` を登録
- [ ] `install.mjs` を汎用化

## 未決事項

- ~~Drive / GitHub は公式 MCP を使う想定~~ → Phase 4 で自前実装に決定(上記)。
- **Google 公式 MCP について (2026-08-30 判断)**: Google が Workspace のリモート MCP を
  Developer Preview で公開している(Drive `drivemcp.googleapis.com` / Calendar
  `calendarmcp.googleapis.com` など)。検討したうえで**現時点では導入しない**:
  - 深掘りは読み取り専用の `bin/drive-fetch.mjs` で足りており、今すぐ入れる理由が無い。
    (公式 Drive MCP のツールは 8 種 — `search_files` / `read_file_content` /
    `download_file_content` / `get_file_metadata` / `get_file_permissions` /
    `list_recent_files` / `copy_file` / `create_file`。要求スコープは `drive.readonly` と
    `drive.file` で、フル書き込みの `.../auth/drive` は要求されない。`drive.file` は
    アプリが作成した / ユーザーが明示的に選んだファイルに限定される per-file スコープなので、
    **既存の研究室資料を書き換え・削除する経路は無い**。当初「書き込みツールが付いてくる」と
    書いたのは Anthropic の Drive コネクタ (11 種・`update_file` / `trash_file` / `share_file`
    を含む) と取り違えたもの。両者は別物。)
  - 横断検索 (`search.mjs` / `experts.mjs`) はヒットをプログラム的に畳み込むので、
    モデル越しの MCP ツールでは代替できない。`mcp-server/`(ChatGPT パス)と
    Discord Bot (`allowedTools: Bash/Read/Skill` + bypassPermissions) も同様。
  - `seminar-calendar` がゼミカレンダー固定なのは安全機構。公式 Calendar MCP は
    全カレンダーに届き `delete_event` を持つため、Bot パスとは相性が悪い。
  - Developer Preview で、Claude から使うには有料プランが要る。
  - 将来 `get_file_permissions` (共有範囲の確認) や Docs/Sheets の構造的な読み取りが
    欲しくなったら「索引 = 自前 / 深掘り = 公式 MCP」の併用で入れる。検証順は
    ① `drive.readonly` のみで繋がるか試す → ② 駄目なら `drive.file` を足す。
    per-tool のスコープ要件は Google が文書化していないので実測が要る。
- ~~Drive を実際に使うには `auth-google.mjs` の再実行が要る~~ → 2026-08-30 に解決。
  ハマりどころが 2 つあった: ① 表示された `GOOGLE_REFRESH_TOKEN` の `.env` への貼り忘れ
  (`--write` で自動更新できるようにした + 許可されたスコープを表示するようにした)、
  ② Cloud プロジェクトで Drive API が未有効 (有効化後、反映まで約 3 分かかった)。
  検証: 共有ドライブ `vdslab` (`0ALCFkqfhR-hGUk9PVA`) を `DRIVE_ID` に設定し、
  "可視化" で 5 件ヒット。`drive-fetch.mjs` で Google スライド → PDF 変換 → Read での
  読み取りまで通ることを確認。`.pptx` はダウンロードできるが Read では読めない
  (出力にその旨を添える)。
- GitHub は `.env` に `GITHUB_TOKEN` / `GITHUB_ORGS=vdslab` を入れると有効になる。
  必要な権限は `docs/GITHUB-TOKEN.md` にまとめた(classic PAT + `repo` を推奨。
  Search 系エンドポイントに必要な fine-grained 権限は GitHub が明記していないため)。
  `scripts/bin/check-github-token.mjs` が機能ごとの可否を実際に叩いて確認する。
- Slack: 自前アプリ + ユーザートークン方式で実装済み(管理者承認は不要だった / 2026-08-30)。
  トークン失効時は slack-app を再インストールして `SLACK_USER_TOKEN` を差し替える。
  重複アプリ `A0BTQ73GE57`(`--environment local` で試した残骸)は `slack app delete` で掃除可。
- `search-vdslab/`(先行の叩き台、未検証)は参照用に残置。使える部分があれば取り込む。
- ~~`mcp-server/`(ChatGPT/Codex 向け)は esa/Slack MCP をカバーしない~~ → Phase 6 で esa は解決
  (`search_lab` / `find_expert` の既定ソースに含まれる)。Slack は自前実装なので元から動く。

## Phase 6 — esa の MCP 非依存化と関連語検索 ✅ (feat/esa-search-expand)

### 背景
- 「esa 検索はこのセッションでは直接使えない」と言われる事象。原因は Phase 1.5 の方針転換で、
  esa の検索経路が **公式 MCP だけ** になっていたこと。MCP が繋がらない/読み込まれない環境
  (ChatGPT / Codex、Discord Bot、MCP 未接続や接続途中のセッション)では esa が丸ごと欠落し、
  スキルもドキュメントも「esa は MCP 側で」と書いてあるため代替手段が無かった。
- 検索が完全一致 AND のみで、「セミナー 日程」と書くと esa 側で 2 件しかヒットしない
  (実際の記事は「ゼミ」「スケジュール」と書かれている)。

### やったこと
- [x] `lib/esa.mjs` に `searchPosts` を**復活**(esa API v1 `/teams/{team}/posts?q=`)。
      `getPost` / `getUser` はそのまま。MCP も消さず併存させる(記事作成など検索以外に使う)。
- [x] `lib/search.mjs` に `esa` ソースを追加し、**既定ソースの先頭**に入れた。
- [x] `lib/expand.mjs`(新規)… クエリを関連語グループに展開する。
      グループ内 OR / グループ間 AND。辞書(研究室の行事・可視化・技術の言い換えと和英)+
      機械的な表記ゆれ(長音・中黒・空白、英語の複数形)の 2 段階。
- [x] `lib/text.mjs` に `matchesGroups` / `scoreGroups` / `groupTerms` を追加。
      `ml` `viz` のような英数字 4 文字以下の語は**語境界で照合**する(`ml` が `html` に誤爆するため)。
- [x] 各ソースに展開を配線: esa / slack / github は API の OR クエリに、drive は
      `(fullText contains A or B) and (...)` に、discord はローカルのグループ照合に。
- [x] calendar は `q` をやめて期間内を取り切ってからローカル照合に変更。
      これに伴い `listEvents` に **ページネーションを追加**(従来 `maxResults: 50` 打ち切りで、
      `q` を外すと静かに取りこぼす状態だった)。照合は**切り詰め前の生イベント**に対して行う
      (`eventToHit` が description を 200 字に切るため)。
- [x] 並び順: 元の語そのものを含むヒットを、関連語だけのヒットより上に出す(`score`)。
- [x] `--related` / `--no-expand` / `--team` を `search.mjs` と `find-expert.mjs` に追加。
- [x] `mcp-server`(Claude Desktop / ChatGPT)の `search_lab` / `find_expert` にも
      `esa` ソースと `expand` / `relatedTerms` を追加。
- [x] スキル 4 本(search-lab / find-schedule / check-shared / find-expert)を
      「esa MCP を呼ぶ」から「`search.mjs --source esa`」に書き換え。
- [x] README / CHATGPT.md の「esa は MCP 側で検索」という記述を訂正。

### 検証 (2026-08-30、実データ)
- `search.mjs "中間報告" --source esa` → 148 件中から中間発表の議事録・ガイダンスがヒット。
- `"セミナー 日程"`: 展開なし 2 件(無関係な自己紹介)→ 展開あり 592 件、上位は実際の
  スケジュール記事・議事録。
- calendar: 展開ありのローカル照合 43 件 = 従来の `q` 43 件(ページネーション修正後に一致)。
- 語境界: `機械学習` の `ml` 変種が `index.html` に誤爆しないことを確認。
- MCP 3 種(esa / seminar-calendar / mcp-server)すべて `initialize` → `tools/list` 応答を確認。
  `mcp-server` の `search_lab` を実呼び出しし、`searched: [calendar, esa]` を確認。

### 残っている制約
- 辞書は研究室ドメインに手で書いたもの。新しい言い換えが増えたら `SYNONYMS` に足す
  (無関係な語を入れるとノイズになるので、実際にその語で書かれた記事がある語だけにする)。
- 展開は再現率を上げる代わりに精度を下げる。週報テンプレの定型文("面白いと感じた Viz")が
  全員の週報に入っているため、`可視化` 系の find-expert は今も定型文ヒットを拾う。
  スキル側で「単に単語が出てくるだけの人を落とす」手順を踏む前提は変わらない。
- GitHub は `GITHUB_TOKEN` 未設定のためこのマシンでは未検証(スキップされる)。
