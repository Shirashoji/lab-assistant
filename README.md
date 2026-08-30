# lab-assistant

研究室の情報基盤(Discord / Slack / esa / Google Calendar / Google Drive / GitHub)を
**横断して検索・調査**し、必要ならゼミの Google Calendar に予定を追加する Claude Code プラグイン。

> `Calendar-agent`(Discord/esa の URL → Google Calendar 予定作成)から fork。
> 全体構想と進め方は [docs/ROADMAP.md](docs/ROADMAP.md)、開発フローは [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 現在の状態

| 機能 | 状態 |
| --- | --- |
| `add-event` — URL(Discord / esa)から予定を抽出 → 重複チェック → カレンダー作成 | ✅ 動作 |
| 横断検索(Discord / esa / Calendar) | 🚧 Phase 1 |
| Slack 連携 | 🚧 Phase 2 |
| `find-schedule` / `check-shared` / `find-channel` / `search-lab` スキル | 🚧 Phase 3(下書きが `skills/` にあります) |
| Google Drive / GitHub | 🚧 Phase 4 |

## 使い方(現状)

```
/lab-assistant:add-event <url> [url ...]
```

例:

```
/lab-assistant:add-event https://discord.com/channels/123/456/789
/lab-assistant:add-event https://myteam.esa.io/posts/1234
```

URL の内容を読み取り、抽出した予定を提示 → 確認 → 重複チェック → 作成します。

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

1. `https://<チーム名>.esa.io/user/applications` → **Personal access tokens**(スコープ **read** で可)
2. `.env` の `ESA_ACCESS_TOKEN` に貼る。必要なら `ESA_DEFAULT_TEAM` も。

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
| `ESA_ACCESS_TOKEN` | ✔ | esa Personal Access Token(read) |
| `ESA_DEFAULT_TEAM` | — | URL からチーム名が取れない場合のフォールバック |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | ✔ | OAuth クライアント |
| `GOOGLE_REFRESH_TOKEN` | ✔ | `auth-google.mjs` で取得 |
| `GOOGLE_CALENDAR_ID` | — | 対象カレンダー。**ゼミカレンダーの ID を推奨**。既定 `primary` |
| `TIMEZONE` | — | 既定 `Asia/Tokyo` |
| `OAUTH_REDIRECT_PORT` | — | 既定 `4779` |

## 接続するカレンダーを変える

1. 対象カレンダーを OAuth に使ったアカウントに「予定の変更権限」で共有
2. `node scripts/bin/list-calendars.mjs` で ID を確認(`owner` / `writer` のみ書き込み可)
3. その ID を `.env` の `GOOGLE_CALENDAR_ID` に設定
4. `node scripts/bin/check-setup.mjs` で「対象カレンダー: <名前>(… / 権限: owner|writer)」を確認

## スクリプト(`scripts/`)

| スクリプト | 用途 |
| --- | --- |
| `bin/collect-context.mjs <url...>` | URL 群から予定抽出用の文脈を JSON 出力 |
| `bin/find-duplicate.mjs --summary S --start ISO` | 重複候補イベントを JSON 出力 |
| `bin/create-event.mjs`(stdin JSON) | 予定を作成 |
| `bin/auth-google.mjs` | Google リフレッシュトークン取得(初回のみ) |
| `bin/list-calendars.mjs [--json]` | アクセスできるカレンダーと ID・権限を一覧 |
| `bin/check-setup.mjs [--quiet]` | 設定と API 疎通の確認 |

実体は `scripts/lib/`(`collect` / `dedupe` / `discord` / `esa` / `gcal` / `url` / `config`)。
`bin/` は薄いラッパー。同じ `lib/` を `bot/`(任意の Discord Bot)と `mcp-server/`(任意の MCP サーバー)も共有します。

## 追加コンポーネント

- `bot/` — 返信＋メンションで `add-event` を実行する Discord Bot(任意)
- `mcp-server/` — 同じロジックを MCP ツールとして公開。ChatGPT / Codex / Claude Desktop 向け([CHATGPT.md](CHATGPT.md))

## 制限(現状)

- 予定の**作成**と**重複チェック**のみ。変更・削除は行いません。
- Discord は Bot が参加し閲覧権限のあるチャンネルのみ。esa はトークンでアクセスできるチームのみ。
