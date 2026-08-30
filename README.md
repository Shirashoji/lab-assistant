# lab-assistant

研究室の情報基盤(Discord / Slack / esa / Google Calendar / Google Drive / GitHub)を
**横断して検索・調査**し、必要ならゼミの Google Calendar に予定を追加する Claude Code プラグイン。

> `Calendar-agent`(Discord/esa の URL → Google Calendar 予定作成)から fork。
> 全体構想と進め方は [docs/ROADMAP.md](docs/ROADMAP.md)、開発フローは [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 現在の状態

| 機能 | 状態 |
| --- | --- |
| `add-event` — URL(Discord / esa)から予定を抽出 → 重複チェック → カレンダー作成 | ✅ 動作 |
| esa 検索 — 公式 MCP `@esaio/esa-mcp-server` を `.mcp.json` でバンドル | ✅ 動作 |
| 横断検索(Calendar / Slack / Discord / GitHub / Drive) — `scripts/bin/search.mjs` | ✅ 動作 |
| スキル `find-schedule` / `check-shared` / `find-channel` / `search-lab` | ✅ 動作 |
| スキル `find-expert` — トピックに詳しい人を根拠付きで探す — `scripts/bin/find-expert.mjs` | ✅ 動作 |
| GitHub 検索(Issue / PR / コード / コミット) | ✅ 動作(`GITHUB_TOKEN` が必要) |
| Google Drive 検索(全文) | ⚠ `auth-google.mjs` の再実行が必要(`drive.readonly` スコープ追加) |
| Claude Desktop 対応 — `search_lab` / `find_expert` を MCP ツールとして公開 | ✅ 動作 |

## アーキテクチャ

- **MCP で扱うもの**は `.mcp.json` でバンドルする(自動登録名 `plugin:lab-assistant:<server>`)。
  - `esa` … 公式 `@esaio/esa-mcp-server`
  - `seminar-calendar` … 公式 MCP が無く、かつ「ゼミカレンダーに固定したい」ので依存ゼロ Node で自作
- **横断検索の実行器**(`scripts/bin/search.mjs` / `lib/`)は依存ゼロ Node。Discord は Bot が検索 API を
  使えず、Slack は公式 MCP に管理者承認が要るため、どちらも raw REST で実装
  (Slack は `search:read` だけの最小アプリ [slack-app/](slack-app/) + ユーザートークン)。
- **スキル**が MCP ツールと `search.mjs` を順に呼び出して結果をまとめる。

## 使い方

| スキル | 用途 |
| --- | --- |
| `/lab-assistant:find-schedule <イベント>` | 「M2 中間報告会いつ?」— Calendar / esa / Slack / Discord を横断して日程を答え、ゼミカレンダーに無ければ追加を提案 |
| `/lab-assistant:check-shared <URL または話題>` | 共有・週報ネタが esa / Slack / Discord で既出でないか(自分の過去分含む)を確認 |
| `/lab-assistant:find-channel <話題>` | その話題を扱っている Discord / Slack チャンネルを特定 |
| `/lab-assistant:search-lab <調べたいこと>` | 研究室・学科の情報を横断検索して出典付きで要約(調べもの全般の入口) |
| `/lab-assistant:add-event <url> [url ...]` | Discord / esa の URL から予定を抽出 → 確認 → 重複チェック → ゼミカレンダーに作成 |

スキルは自然文でも起動します(例:「次のゼミの発表会いつだっけ」)。

## セットアップ

### 0. 前提

- Node.js 18 以上(コアスクリプトは依存ゼロ、`npm install` 不要)
- プラグインの読み込み: 開発中は `claude --plugin-dir ./lab-assistant`

### 1. `.env` を用意

```bash
cp .env.example .env
```

### 2. Discord Bot を作成

1. <https://discord.com/developers/applications> → **New Application**
2. **Bot** → **Reset Token** を `.env` の `DISCORD_BOT_TOKEN` に貼る
3. **Privileged Gateway Intents** で **MESSAGE CONTENT INTENT** を ON
4. **OAuth2 → URL Generator**: SCOPES `bot` / PERMISSIONS `View Channels`, `Read Message History` → 生成 URL で対象サーバーに招待

> URL を読むだけの機能でも、Bot が対象サーバーに参加していないと Discord API でメッセージを読めません。

### 3. esa の Personal Access Token

1. `https://<チーム名>.esa.io/user/applications` → **Personal access tokens**(**PAT v2** 推奨。閲覧/検索だけなら read 系スコープで可)
2. `.env` の `ESA_ACCESS_TOKEN` に貼る。必要なら `ESA_DEFAULT_TEAM` も。

このトークンは 2 箇所で使われます:
- `add-event` フロー(Discord メッセージ内の esa リンク → 記事取得)の raw REST
- **esa 公式 MCP**(`@esaio/esa-mcp-server`)。`.mcp.json` でバンドルしており、Claude Code が
  プラグイン読み込み時に `plugin:lab-assistant:esa` として自動登録します。起動ラッパ
  `scripts/bin/esa-mcp.mjs` が `.env` からトークンを読んで渡すので、追加設定は不要です。
  初回起動時は `npx` が `@esaio/esa-mcp-server` を取得するため少し時間がかかります。

### 3.5 Slack(任意 / 学科ワークスペースの検索用)

[slack-app/README.md](slack-app/README.md) の手順で最小アプリをインストールし、
**User OAuth Token(`xoxp-`)** を `.env` の `SLACK_USER_TOKEN` に入れる。未設定でも他機能は動く。

### 4. Google Calendar の OAuth(ゼミ用カレンダーを対象に)

1. <https://console.cloud.google.com/> でプロジェクト作成 → **Google Calendar API** を有効化
2. **OAuth 同意画面**(External / テストユーザーに自分を追加)
3. **認証情報 → OAuth クライアント ID**、種類 **デスクトップ アプリ**
4. **クライアント ID / シークレット** を `.env` の `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` に
5. リフレッシュトークン取得:
   ```bash
   node scripts/bin/auth-google.mjs
   ```
6. **ゼミのカレンダー ID を `GOOGLE_CALENDAR_ID` に設定**(下記)。

> Claude アプリ標準の Google Calendar コネクタとは別に、このプラグインは自前 OAuth +
> `GOOGLE_CALENDAR_ID` で **ゼミ用カレンダー**だけを操作します。予定の確認・追加は必ずこの経路を使います。

### 5. 動作確認

```bash
node scripts/bin/check-setup.mjs
```

## `.env` キー一覧

| キー | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | ✔ | Discord Bot トークン |
| `ESA_ACCESS_TOKEN` | ✔ | esa Personal Access Token(PAT v2 推奨)。add-event と esa MCP が使う |
| `ESA_DEFAULT_TEAM` | — | URL からチーム名が取れない場合のフォールバック |
| `SLACK_USER_TOKEN` | — | 学科 Slack 検索用の User OAuth Token(`xoxp-`)。[slack-app/](slack-app/) 参照 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✔ | OAuth クライアント |
| `GOOGLE_REFRESH_TOKEN` | ✔ | `auth-google.mjs` で取得 |
| `GOOGLE_CALENDAR_ID` | — | 対象カレンダー。**ゼミカレンダーの ID を推奨**。既定 `primary` |
| `TIMEZONE` | — | 既定 `Asia/Tokyo` |
| `OAUTH_REDIRECT_PORT` | — | 既定 `4779` |
| `GITHUB_TOKEN` | — | GitHub 検索用の PAT。未設定なら github ソースはスキップ |
| `GITHUB_ORGS` | — | 検索対象の org(カンマ区切り)。例 `vdslab`。未設定だと GitHub 全体 |
| `GITHUB_REPOS` | — | さらに絞る場合の `owner/name`(カンマ区切り) |
| `DRIVE_FOLDER_IDS` | — | Drive 検索の対象フォルダ ID(カンマ区切り) |
| `DRIVE_MIME_TYPES` | — | Drive 検索の対象 MIME タイプ(カンマ区切り) |

## 接続するカレンダーを変える

1. 対象カレンダーを OAuth に使ったアカウントに「予定の変更権限」で共有
2. `node scripts/bin/list-calendars.mjs` で ID を確認(`owner` / `writer` のみ書き込み可)
3. その ID を `.env` の `GOOGLE_CALENDAR_ID` に設定
4. `node scripts/bin/check-setup.mjs` で「対象カレンダー: <名前>(… / 権限: owner|writer)」を確認

## バンドル MCP(`.mcp.json`)

`.mcp.json` に宣言した MCP サーバーは、Claude Code がプラグイン読み込み時に
`plugin:lab-assistant:<server>` として自動登録します。認証情報は `scripts/bin/<x>-mcp.mjs` の
起動ラッパが `.env` から渡すので、`.env` 一元管理のままです。

| サーバー | 実体 | 提供ツール | 認証 |
| --- | --- | --- | --- |
| `esa` | `@esaio/esa-mcp-server`(`scripts/bin/esa-mcp.mjs`) | `esa_search_posts` / `esa_get_post` ほか | `.env` の `ESA_ACCESS_TOKEN` |
| `seminar-calendar` | 自作の依存ゼロ stdio MCP(`scripts/bin/seminar-calendar-mcp.mjs`) | `list_events` / `search_events` / `find_duplicate_events` / `create_event` / `list_calendars` | `.env` の Google OAuth |


GitHub と Google Drive は公式 MCP ではなく `scripts/lib/` の依存ゼロ実装で検索します
(GitHub は REST search API + `GITHUB_TOKEN`、Drive は Calendar と同じ Google OAuth を再利用)。

- **esa**: `esa_search_posts` の引数 `teamName` は `.env` の `ESA_DEFAULT_TEAM`(不明なら `esa_get_teams`)。
- **seminar-calendar**: すべての操作が `.env` の `GOOGLE_CALENDAR_ID`(= ゼミカレンダー)に**固定**される。
  Claude アプリ標準の Google Calendar コネクタと混同しないための専用サーバー。予定の確認・追加は
  スキルがこのサーバー経由で行う(`bin/*.mjs` は bot / ChatGPT 用のフォールバック)。

### Slack — 自前アプリ + ユーザートークン

Slack の**ワークスペース検索(`search.messages`)はユーザートークン限定**で、公式 MCP は
ワークスペース管理者の承認が要ります。そこで `search:read` だけを持つ最小アプリ
([slack-app/](slack-app/))を Slack CLI で学科ワークスペースにインストールし、その
**User OAuth Token(`xoxp-`)** を `.env` の `SLACK_USER_TOKEN` に入れて raw REST で検索します。
セットアップは [slack-app/README.md](slack-app/README.md)。`search.mjs` の `slack` ソースがこれを使います。

## 横断検索(`scripts/bin/search.mjs`)

Calendar(ゼミ)/ Slack(学科)/ Discord / GitHub / Google Drive をまたいでキーワード検索し、共通形式
(`source` / `title` / `url` / `snippet` / `author` / `timestamp`)の JSON を返します。
esa はバンドル MCP 側で検索し、スキルが結果をまとめます。

```bash
node scripts/bin/search.mjs "中間報告会"
node scripts/bin/search.mjs "M2 中間報告" --source slack --text
node scripts/bin/search.mjs "可視化 D3" --since 2026-04-01 --limit 30
node scripts/bin/search.mjs "ゼミ リスケ" --source discord --channels 123,456
node scripts/bin/search.mjs "可視化" --source github --kinds issues,code --text
node scripts/bin/search.mjs "研究会 スライド" --source drive --limit 10
```

| オプション | 説明 |
| --- | --- |
| `--source a,b` | 検索対象。既定は設定済みの全ソース(`calendar,slack,discord,github,drive`) |
| `--kinds a,b` | GitHub の検索種別。`issues`(既定)/ `code` / `commits` / `repos` |
| `--since` / `--until` | 期間(`YYYY-MM-DD` か ISO8601) |
| `--sort` | `relevance`(既定・今日からの近さ順)/ `newest` / `oldest` |
| `--limit N` | 最大件数(既定 40) |
| `--channels a,b` | Discord: チャンネル ID で限定 / Slack: `in:` 演算子でチャンネル名か ID |
| `--max-channels N` | Discord で自動選択するチャンネル数の上限(既定 80) |
| `--text` | JSON でなく整形テキストで出力 |

- **Slack** は自前アプリのユーザートークン(`SLACK_USER_TOKEN`)で `search.messages` を叩きます。
  検索範囲は**そのトークンの持ち主が見えるチャンネル**。`--since` / `--until` は Slack の
  `after:` / `before:` 演算子に変換されます。未設定ならスキップされます。
- **Discord** はメッセージ検索 API が Bot では使えないため、対象チャンネルの直近メッセージを
  取得してクライアント側でフィルタします。期間未指定なら各チャンネル直近 100 件のみ。
  `--since` を付けると遡ります。Bot が参加していないチャンネル/閲覧権限の無いチャンネルは
  対象外です(結果の `warnings` に件数が出ます)。学科の重要チャンネル(週報・ゼミアナウンス等)を
  検索したい場合は、その Bot ロールに「チャンネルを見る」「メッセージ履歴を読む」を付与してください。
- 対象ギルドは `.env` の `DISCORD_GUILD_IDS`(未設定なら Bot の全参加サーバー)。

## 詳しい人を探す(`scripts/bin/find-expert.mjs`)

横断検索のヒットを **投稿者ごとに畳み込み**、「そのトピックに詳しそうな人」を
根拠(投稿・記事のリンク)付きで返します。

```bash
node scripts/bin/find-expert.mjs "MCP" --since 2025-01-01 --top 5 --text
node scripts/bin/find-expert.mjs "トーラス" --source discord,slack --evidence 3 --text
# esa MCP で検索した結果 (共通ヒット形の JSON) を混ぜる
cat esa-hits.json | node scripts/bin/find-expert.mjs "根付き木" --extra-hits - --text
```

| オプション | 説明 |
| --- | --- |
| `--top N` | 返す人数(既定 8) |
| `--evidence N` | 1 人あたりの根拠件数(既定 5) |
| `--extra-hits <path\|->` | esa など MCP 側の結果を共通ヒット形の JSON で混ぜる |
| `--alias "a=b,c=b"` | 表記ゆれの名寄せ |
| `--include-bots` | GitHub 連携などの Bot 投稿も含める(既定は除外) |
| `--half-life N` | 鮮度の半減期(日、既定 365) |
| `--min-hits N` | 根拠がこの件数未満の人を落とす |

スコアは **ソースの重み × 鮮度 × 検索語の濃さ**(+ 複数ソース出現ボーナス)の合計で、
記事を書いている人 (esa 3.0) > コードや Issue (github 2.5) > 資料 (drive 2.0) >
発言 (discord / slack 1.0) > 予定 (calendar 0.4) の順に重く見ます。
**あくまで機械的なヒント**なので、根拠を読んでから答えること(`skills/find-expert/` が
その手順を持っています)。

## Claude Desktop で使う

```bash
node scripts/install.mjs claude-desktop   # 依存導入 + ビルド + 設定登録まで自動
```

`lab-assistant`(検索・予定作成)に加えて、Claude Code で `.mcp.json` から自動登録される
バンドル MCP を `lab-assistant-esa` / `lab-assistant-seminar-calendar` として同時に登録します。
登録後は **Claude Desktop を完全に再起動**してください。
`node scripts/install.mjs status` で導入状況を確認できます。

## スクリプト(`scripts/`)

| スクリプト | 用途 |
| --- | --- |
| `bin/search.mjs "<query>" [opts]` | Calendar(ゼミ)/ Slack / Discord / GitHub / Drive の横断検索(上記) |
| `bin/find-expert.mjs "<topic>" [opts]` | トピックに詳しい人を根拠付きで推定(下記) |
| `bin/esa-mcp.mjs` | esa 公式 MCP の起動ラッパ(`.mcp.json` から使用。直接実行しない) |
| `bin/seminar-calendar-mcp.mjs` | ゼミカレンダー専用 MCP サーバー(`.mcp.json` から使用) |
| `bin/collect-context.mjs <url...>` | URL 群から予定抽出用の文脈を JSON 出力 |
| `bin/find-duplicate.mjs --summary S --start ISO` | 重複候補イベントを JSON 出力 |
| `bin/create-event.mjs`(stdin JSON) | 予定を作成 |
| `bin/auth-google.mjs` | Google リフレッシュトークン取得(初回のみ) |
| `bin/list-calendars.mjs [--json]` | アクセスできるカレンダーと ID・権限を一覧 |
| `bin/check-setup.mjs [--quiet]` | 設定と API 疎通の確認(横断検索の準備状況も表示) |

実体は `scripts/lib/`(`search` / `experts` / `collect` / `dedupe` / `discord` / `esa` / `slack` / `github` / `gdrive` / `gcal` / `url` / `text` / `mcp-stdio` / `config`)。
`bin/` は薄いラッパー。同じ `lib/` を `bot/`(任意の Discord Bot)と `mcp-server/`(任意の MCP サーバー)も共有します。

## 追加コンポーネント

- `bot/` — 返信＋メンションで `add-event` を実行する Discord Bot(任意)
- `mcp-server/` — 同じロジックを MCP ツールとして公開。ChatGPT / Codex / Claude Desktop 向け([CHATGPT.md](CHATGPT.md))
  公開ツール: `collect_context` / `find_duplicate_events` / `create_event` /
  `search_lab` / `find_expert` / `list_search_sources`

## 制限(現状)

- 予定の**作成**と**重複チェック**のみ。変更・削除は行いません。
- Discord は Bot が参加し閲覧権限のあるチャンネルのみ。esa はトークンでアクセスできるチームのみ。
