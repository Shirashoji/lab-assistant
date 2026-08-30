# calendar-agent

Discord のメッセージや esa の記事の URL を渡すと、その内容から **Google Calendar の予定を作成**する Claude Code プラグインです。

- 返信チェーン・スレッド・前後に分割されたメッセージをまとめて読む
- Discord メッセージ内の esa リンクも自動で読む
- 入力パターン: **esa のみ / Discord のみ / 両方**
- すでに同じ予定がカレンダーにあれば作成せず、「作成済みです」＋予定リンクを返す
- 追加コンポーネントとして **Discord Bot**（返信＋メンションで同じ動作）を同梱（`bot/`）
- 同じロジックを **MCP サーバー**でも公開。ChatGPT / Codex / Claude Desktop からも使える（`mcp-server/`、[CHATGPT.md](CHATGPT.md)）

## 使い方

```
/calendar-agent:add-event <url> [url ...]
```

例:

```
/calendar-agent:add-event https://discord.com/channels/123/456/789
/calendar-agent:add-event https://myteam.esa.io/posts/1234
/calendar-agent:add-event https://myteam.esa.io/posts/1234 https://discord.com/channels/123/456/789
```

URL を渡すだけで内容を読み取り、抽出した予定を提示 → 確認 → 重複チェック → 作成します。

## セットアップ

### 0. 前提

- Node.js 18 以上（コアスクリプトは追加の `npm install` 不要 / 依存ゼロ）
- プラグインの読み込み: 開発中は `claude --plugin-dir ./Calendar-agent`、
  もしくは `Agent-Plugins/` をマーケットプレイスとして追加

### 1. `.env` を用意

```bash
cp .env.example .env
```

以降の手順で取得した値を `.env` に記入します。

### 2. Discord Bot を作成

1. <https://discord.com/developers/applications> → **New Application**
2. 左メニュー **Bot** → **Reset Token** でトークンを表示し `.env` の `DISCORD_BOT_TOKEN` に貼る
3. 同じ **Bot** 画面の **Privileged Gateway Intents** で **MESSAGE CONTENT INTENT** を ON
4. 左メニュー **OAuth2 → URL Generator**:
   - SCOPES: `bot`
   - BOT PERMISSIONS: `View Channels`, `Read Message History`（Bot も使うなら `Send Messages` も）
   - 生成された URL を開き、対象サーバーに Bot を招待
5. 予定メッセージのあるチャンネルを Bot が閲覧できることを確認

> URL を投げるだけの機能でも、Bot が対象サーバーに参加していないと Discord API でメッセージを読めません。

### 3. esa の Personal Access Token を発行

1. `https://<チーム名>.esa.io/user/applications` を開く
2. **Personal access tokens** → 新規発行（スコープは **read** で十分。PAT v2 推奨）
3. `.env` の `ESA_ACCESS_TOKEN` に貼る
4. 通常はチーム名を URL から取得しますが、取れない場合に備えて `ESA_DEFAULT_TEAM` も設定可

> **esa 公式 MCP について**: esa には公式のローカル MCP サーバー（`@esaio/esa-mcp-server`）が
> あります。本プラグインが esa に求めるのは「URL の記事 1 件の取得」だけで、使うのは esa API の中でも
> 最も安定した `GET /v1/teams/{team}/posts/{number}` 1 本なので、依存ゼロ・一括収集・skill/bot 共通を
> 優先して API 直叩き（`scripts/lib/esa.mjs`）にしています。検索・投稿など踏み込んだ esa 操作が必要に
> なったら、`.mcp.json` に公式 MCP を追加する余地があります。

### 4. Google Calendar の OAuth を設定

1. <https://console.cloud.google.com/> でプロジェクトを作成
2. **APIとサービス → ライブラリ** で **Google Calendar API** を有効化
3. **OAuth 同意画面**: User Type = External、テストユーザーに自分の Google アカウントを追加
4. **認証情報 → 認証情報を作成 → OAuth クライアント ID**、種類は **デスクトップ アプリ**
5. 表示された **クライアント ID / クライアント シークレット** を `.env` の
   `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` に貼る
6. リフレッシュトークンを取得:
   ```bash
   node scripts/bin/auth-google.mjs
   ```
   ブラウザで許可 → 表示された `GOOGLE_REFRESH_TOKEN=...` を `.env` に貼る
7. 予定を入れたいカレンダーが `primary` でなければ `GOOGLE_CALENDAR_ID` を設定（下記「接続するカレンダーを変える」）

### 5. 動作確認

```bash
node scripts/bin/check-setup.mjs
```

Discord / esa / Google Calendar がすべて ✅ になれば準備完了です。

## `.env` キー一覧

| キー | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | ✔ | Discord Bot トークン |
| `ESA_ACCESS_TOKEN` | ✔ | esa Personal Access Token（read） |
| `ESA_DEFAULT_TEAM` | — | URL からチーム名が取れない場合のフォールバック |
| `GOOGLE_CLIENT_ID` | ✔ | OAuth クライアント ID |
| `GOOGLE_CLIENT_SECRET` | ✔ | OAuth クライアント シークレット |
| `GOOGLE_REFRESH_TOKEN` | ✔ | `auth-google.mjs` で取得 |
| `GOOGLE_CALENDAR_ID` | — | 予定の作成先。既定 `primary`。研究室カレンダー等は下記参照 |
| `TIMEZONE` | — | 既定 `Asia/Tokyo` |
| `OAUTH_REDIRECT_PORT` | — | 既定 `4779`（`auth-google.mjs` 用） |

## 接続するカレンダーを変える（研究室カレンダーなど）

既定は `primary`（OAuth に使った Google アカウントの個人カレンダー）です。研究室の共有カレンダーに
入れるには:

1. Google カレンダーで対象カレンダーを、OAuth に使ったアカウントに **「予定の変更権限」** で共有する
   （所有者に依頼、または自分が所有者ならそのままで可）
2. アクセスできるカレンダーと ID を確認:
   ```bash
   node scripts/bin/list-calendars.mjs
   ```
   `owner` か `writer` のものだけが書き込み可能です。
3. その ID を `.env` に設定:
   ```
   GOOGLE_CALENDAR_ID=xxxxxxxx@group.calendar.google.com
   ```
4. 確認:
   ```bash
   node scripts/bin/check-setup.mjs
   ```
   「対象カレンダー: <名前>（… / 権限: owner|writer）」と出れば OK。

> 1 回だけ別カレンダーに入れたいときは、`.env` を変えずにスキルに「〜のカレンダーに」と伝えれば、
> Claude が `create-event.mjs --calendar <id>`（MCP なら `calendarId` 引数）で切り替えます。

## 重複判定の仕様

`scripts/bin/find-duplicate.mjs` が予定開始時刻の前後 26 時間の既存イベントを取得し、
タイトルの正規化一致と開始時刻の近さで「候補」を洗い出します。
**最終的に「同じ予定かどうか」を判断するのは Claude**（`add-event` スキル）で、
タイトル・日時・場所を意味的に見て判断します。同一と判断された場合は作成せず、
その予定のリンクを返します。

## スクリプト（`scripts/`）

| スクリプト | 用途 |
| --- | --- |
| `bin/collect-context.mjs <url...>` | URL 群から予定抽出用の文脈を JSON 出力 |
| `bin/find-duplicate.mjs --summary S --start ISO` | 重複候補イベントを JSON 出力 |
| `bin/create-event.mjs`（stdin JSON） | 予定を作成 |
| `bin/auth-google.mjs` | Google リフレッシュトークン取得（初回のみ） |
| `bin/list-calendars.mjs [--json]` | アクセスできるカレンダーと ID・権限を一覧 |
| `bin/check-setup.mjs [--quiet]` | 設定と API 疎通の確認（対象カレンダーの書き込み権限も検査） |

実体は `scripts/lib/`（`collect` / `dedupe` / `discord` / `esa` / `gcal` / `url` / `config`）にあり、
`bin/` はその薄いラッパーです。同じ `lib/` を Bot と MCP サーバーも共有します。

## Discord Bot（追加コンポーネント）

`bot/` を参照してください。返信＋メンションで `add-event` スキルを実行します。
プラグイン本体だけでも運用できるので、Bot は後から追加で構いません。

## 各アプリへの導入（インストーラ）

`scripts/install.mjs` が、共通セットアップ（`.env`）を済ませた状態から各アプリへの登録を行います。

```bash
node scripts/install.mjs status            # 導入状況を表示
node scripts/install.mjs claude-desktop    # Claude Desktop アプリに MCP サーバーを登録
node scripts/install.mjs claude-code       # Claude Code にプラグインを登録（marketplace 追加 + install）
node scripts/install.mjs chatgpt           # ChatGPT カスタムコネクタ用の HTTP サーバーを準備・案内
node scripts/install.mjs chatgpt --serve   #   ↑ に加えて HTTP サーバーをその場で起動
node scripts/install.mjs uninstall claude-desktop   # 解除
```

- `--dry-run` を付けると変更内容だけ表示します。
- `claude-desktop`: `claude_desktop_config.json` の `mcpServers` に `calendar-agent` を追記します
  （既存サーバーは保持、変更前に `.bak-<日時>` を作成）。node は安定パスを自動解決。実行後にアプリを再起動。
- `claude-code`: Claude Code で使うなら本来は `--plugin-dir` かこのコマンドだけで OK（MCP は不要）。
- `chatgpt`: `MCP_AUTH_TOKEN` を自動生成し、HTTP サーバーの起動・トンネル・コネクタ登録手順を表示します。
  詳細は [CHATGPT.md](CHATGPT.md)。

いずれも初回は `mcp-server` の `npm install` とビルド（`dist/`）を自動で実行します。

## 他のクライアント（MCP）

`mcp-server/` が、同じロジックを **MCP ツール**（`collect_context` / `find_duplicate_events` /
`create_event`）として公開します。stdio と Streamable HTTP の両対応。

- **ChatGPT** → [CHATGPT.md](CHATGPT.md)
- **Codex CLI / Claude Desktop**（stdio 接続の手動設定）→ [mcp-server/README.md](mcp-server/README.md)

Claude Code で使うだけなら不要です。

## 制限

- 予定の**作成**と**重複チェック**のみ。変更・削除は行いません。
- Discord は Bot が参加していて閲覧権限のあるチャンネルのみ読めます。
- esa はトークンでアクセスできるチームの記事のみ読めます。
