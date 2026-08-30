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
| 横断検索(Calendar / Slack / Discord) — `scripts/bin/search.mjs` | ✅ 動作 |
| スキル `find-schedule` / `check-shared` / `find-channel` / `search-lab` | ✅ 動作 |
| Google Drive / GitHub | 🚧 Phase 4 |

## アーキテクチャ

- **公式 MCP がある情報源**(esa、将来: GitHub / Drive)は、その MCP サーバーを
  `.mcp.json` でバンドルする。Claude Code はプラグイン読み込み時に自動登録し、
  `plugin:lab-assistant:<server>` という名前で使えるようになる。
- **公式 MCP が無い / 精密な制御が要る**もの(Discord 検索、Slack 検索、ゼミカレンダーの予定操作)は
  `scripts/` の依存ゼロ Node スクリプトで実装する。
  - Slack は公式 MCP もあるが、接続に**ワークスペース管理者の承認**が要る。承認が下りない場合の
    代替として、`search:read` だけを持つ最小アプリ([slack-app/](slack-app/))+ ユーザートークンで
    `search.messages` を叩く方式にしている。
- **スキル**が両者を順に呼び出して結果をまとめる。

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

## 接続するカレンダーを変える

1. 対象カレンダーを OAuth に使ったアカウントに「予定の変更権限」で共有
2. `node scripts/bin/list-calendars.mjs` で ID を確認(`owner` / `writer` のみ書き込み可)
3. その ID を `.env` の `GOOGLE_CALENDAR_ID` に設定
4. `node scripts/bin/check-setup.mjs` で「対象カレンダー: <名前>(… / 権限: owner|writer)」を確認

## バンドル MCP(`.mcp.json`)

公式 MCP がある情報源は、そのサーバーを `.mcp.json` に宣言してプラグインに同梱します。
Claude Code はプラグイン読み込み時に `plugin:lab-assistant:<server>` として自動登録します。

| サーバー | 実体 | 認証 |
| --- | --- | --- |
| `esa` | `@esaio/esa-mcp-server`(`scripts/bin/esa-mcp.mjs` 経由で `.env` のトークンを注入) | `.env` の `ESA_ACCESS_TOKEN` |
| `github` / `google-drive` | (Phase 4) | — |

esa の検索は MCP ツール `esa_search_posts`(引数 `teamName` が必要 — `.env` の
`ESA_DEFAULT_TEAM`、または `esa_get_teams` で確認)を使います。スキルがこれを呼びます。

### Slack — 自前アプリ + ユーザートークン

Slack の**ワークスペース検索(`search.messages`)はユーザートークン限定**で、公式 MCP は
ワークスペース管理者の承認が要ります。そこで `search:read` だけを持つ最小アプリ
([slack-app/](slack-app/))を Slack CLI で学科ワークスペースにインストールし、その
**User OAuth Token(`xoxp-`)** を `.env` の `SLACK_USER_TOKEN` に入れて raw REST で検索します。
セットアップは [slack-app/README.md](slack-app/README.md)。`search.mjs` の `slack` ソースがこれを使います。

## 横断検索(`scripts/bin/search.mjs`)

Calendar(ゼミ)/ Slack(学科)/ Discord をまたいでキーワード検索し、共通形式
(`source` / `title` / `url` / `snippet` / `author` / `timestamp`)の JSON を返します。
esa はバンドル MCP 側で検索し、スキルが結果をまとめます。

```bash
node scripts/bin/search.mjs "中間報告会"
node scripts/bin/search.mjs "M2 中間報告" --source slack --text
node scripts/bin/search.mjs "可視化 D3" --since 2026-04-01 --limit 30
node scripts/bin/search.mjs "ゼミ リスケ" --source discord --channels 123,456
```

| オプション | 説明 |
| --- | --- |
| `--source a,b` | 検索対象。既定は `calendar,slack,discord` |
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

## スクリプト(`scripts/`)

| スクリプト | 用途 |
| --- | --- |
| `bin/search.mjs "<query>" [opts]` | Calendar(ゼミ)/ Slack / Discord の横断検索(上記) |
| `bin/esa-mcp.mjs` | esa 公式 MCP の起動ラッパ(`.mcp.json` から使用。直接実行しない) |
| `bin/collect-context.mjs <url...>` | URL 群から予定抽出用の文脈を JSON 出力 |
| `bin/find-duplicate.mjs --summary S --start ISO` | 重複候補イベントを JSON 出力 |
| `bin/create-event.mjs`(stdin JSON) | 予定を作成 |
| `bin/auth-google.mjs` | Google リフレッシュトークン取得(初回のみ) |
| `bin/list-calendars.mjs [--json]` | アクセスできるカレンダーと ID・権限を一覧 |
| `bin/check-setup.mjs [--quiet]` | 設定と API 疎通の確認(横断検索の準備状況も表示) |

実体は `scripts/lib/`(`search` / `collect` / `dedupe` / `discord` / `esa` / `gcal` / `url` / `text` / `config`)。
`bin/` は薄いラッパー。同じ `lib/` を `bot/`(任意の Discord Bot)と `mcp-server/`(任意の MCP サーバー)も共有します。

## 追加コンポーネント

- `bot/` — 返信＋メンションで `add-event` を実行する Discord Bot(任意)
- `mcp-server/` — 同じロジックを MCP ツールとして公開。ChatGPT / Codex / Claude Desktop 向け([CHATGPT.md](CHATGPT.md))

## 制限(現状)

- 予定の**作成**と**重複チェック**のみ。変更・削除は行いません。
- Discord は Bot が参加し閲覧権限のあるチャンネルのみ。esa はトークンでアクセスできるチームのみ。
