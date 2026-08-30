# lab-assistant 導入ガイド(研究室メンバー向け)

研究室の情報基盤(Discord / Slack / esa / Google Calendar / Google Drive / GitHub)を
横断検索するプラグインです。このドキュメントは **自分の PC に入れて使いたい人** 向けの手順です。

- 機能の説明・オプション一覧 → [../README.md](../README.md)
- ChatGPT / Codex 固有の話 → [../CHATGPT.md](../CHATGPT.md)
- 開発の経緯 → [ROADMAP.md](ROADMAP.md)

---

## 0. 最初に知っておくこと

**認証情報は各自で用意します。** このプラグインは「あなたのアカウントで見えるものだけ」を検索します。
`.env` は共有しないでください(Discord Bot トークン・esa PAT・Google のリフレッシュトークンが入ります)。

| 資格情報 | 各自で取る? | 無いとどうなる |
| --- | --- | --- |
| esa PAT | ✅ 各自 | esa 検索と add-event が使えない |
| Google OAuth | ✅ 各自 | カレンダー・Drive が使えない |
| Discord Bot | ⚠️ 下記参照 | Discord 検索が使えない |
| Slack ユーザートークン | ✅ 各自(任意) | Slack 検索がスキップされる |
| GitHub PAT | ✅ 各自(任意) | GitHub 検索がスキップされる |

> **Discord Bot について**: Bot は「サーバーに参加していること」が必要です。研究室サーバーに
> 既に Bot がいる場合、**新しく自分の Bot を作って招待する**のが基本です(サーバーの管理権限が要ります)。
> 招待権限が無ければ、サーバー管理者に依頼してください。トークンの共有は避けてください。

未設定のソースは**自動でスキップ**され、他の機能は動きます。まず esa + Google だけ設定して、
あとから Slack / GitHub / Discord を足す進め方で構いません。

---

## 1. 必要なもの

- **Node.js 18 以上**(`node -v` で確認。コアスクリプトは依存ゼロで `npm install` 不要)
- **git**
- 使いたいアプリのどれか: Claude Code / Claude Desktop / ChatGPT デスクトップ / Codex CLI

---

## 2. 取得する

プラグイン本体はリポジトリですが、**マーケットプレイス定義は親ディレクトリ**に置く構成です。
親ディレクトリの名前は何でも構いません(ここでは `Agent-Plugins`)。

```bash
mkdir -p ~/develop/Agent-Plugins && cd ~/develop/Agent-Plugins
git clone https://github.com/Shirashoji/lab-assistant.git
cd lab-assistant
```

結果としてこうなります。マーケットプレイス定義(`.claude-plugin/` / `.agents/`)は
**インストーラが自動生成する**ので、手で作る必要はありません。

```
Agent-Plugins/            ← マーケットプレイスの root (git 管理外)
├── .claude-plugin/       ← 自動生成
├── .agents/              ← 自動生成
└── lab-assistant/        ← clone したリポジトリ
```

---

## 3. `.env` を用意する

```bash
cp .env.example .env
```

以下、必要なものだけ埋めます。全キーの一覧は [../README.md](../README.md) の「`.env` キー一覧」にあります。

### 3.1 esa(必須)

1. `https://vdslab.esa.io/user/applications` → **Personal access tokens**(PAT v2 推奨)
2. 検索と閲覧だけなら **read 系スコープ**で十分
3. `.env` に設定:
   ```
   ESA_ACCESS_TOKEN=<取得したトークン>
   ESA_DEFAULT_TEAM=vdslab
   ```

### 3.2 Google(必須 / カレンダーと Drive)

1. <https://console.cloud.google.com/> でプロジェクトを作成
2. **Google Calendar API** と **Google Drive API** を有効化
   (Drive API は有効化の反映に数分かかることがあります)
3. **OAuth 同意画面** → External、テストユーザーに自分のアカウントを追加
4. **認証情報 → OAuth クライアント ID** → 種類 **デスクトップ アプリ**
5. `.env` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を設定
6. リフレッシュトークンを取得(`--write` で `.env` に自動で書き込みます):
   ```bash
   node scripts/bin/auth-google.mjs --write
   ```
7. ゼミのカレンダー ID を設定:
   ```bash
   node scripts/bin/list-calendars.mjs   # 一覧から ID を探す
   ```
   ```
   GOOGLE_CALENDAR_ID=<ゼミカレンダーの ID>
   ```
8. 研究室の共有ドライブに絞る(推奨。未設定だとマイドライブ全体が対象になります):
   ```bash
   node scripts/bin/list-drives.mjs
   ```
   ```
   DRIVE_ID=<共有ドライブの ID>
   ```

> **カレンダーは必ず `GOOGLE_CALENDAR_ID` で指定してください。** 既定の `primary` のままだと
> 個人カレンダーを操作してしまいます。予定の追加は必ずこの ID のカレンダーに対して行われます。

### 3.3 Discord(任意)

1. <https://discord.com/developers/applications> → **New Application**
2. **Bot** → **Reset Token** を `.env` の `DISCORD_BOT_TOKEN` に
3. **Privileged Gateway Intents** で **MESSAGE CONTENT INTENT** を ON
   (これを忘れるとメッセージ本文が空で返ります)
4. **OAuth2 → URL Generator**: SCOPES `bot` / PERMISSIONS `View Channels` + `Read Message History`
5. 生成された URL で研究室サーバーに招待
6. 対象サーバーを絞る:
   ```
   DISCORD_GUILD_IDS=<サーバー ID>
   ```

> Bot に閲覧権限が無いチャンネルは検索対象外です。検索結果の `warnings` に件数が出ます。

### 3.4 Slack(任意 / 学科ワークスペース)

[../slack-app/README.md](../slack-app/README.md) の手順で最小アプリ(`search:read` のみ)を
インストールし、**User OAuth Token(`xoxp-`)** を `SLACK_USER_TOKEN` に設定します。
検索できる範囲は**あなたが見えるチャンネル**だけです。

### 3.5 GitHub(任意)

1. <https://github.com/settings/tokens> で **classic PAT** を発行(`repo` スコープ)
2. ```
   GITHUB_TOKEN=<トークン>
   GITHUB_ORGS=vdslab
   ```
3. 確認: `node scripts/bin/check-github-token.mjs`

詳細・fine-grained PAT の場合は [GITHUB-TOKEN.md](GITHUB-TOKEN.md) を参照。

---

## 4. 動作確認

```bash
node scripts/bin/check-setup.mjs
```

各ソースの疎通と、横断検索の準備状況が出ます。未設定のものは `—` で表示され、スキップされます。

試しに検索してみます:

```bash
node scripts/bin/search.mjs "中間発表 日程" --source esa --limit 5 --text
```

`関連語も検索:` の行が出れば、関連語展開まで含めて動いています。

---

## 5. 使いたいアプリに導入する

導入・更新・解除はすべて `scripts/install.mjs` から行います。

```bash
node scripts/install.mjs status               # 今の導入状況
node scripts/install.mjs install <target>     # 導入
node scripts/install.mjs update  <target>     # 最新の内容に入れ替え
node scripts/install.mjs uninstall <target>   # 解除
```

`--dry-run` を付けると、何も変更せず実行内容だけ表示します。

| target | 対象 | 形式 |
| --- | --- | --- |
| `claude-code` | Claude Code (skills + MCP + hooks) | 参照型。更新後は `/reload-plugins` |
| `claude-desktop` | Claude Desktop に MCP を登録 | 参照型。更新後は**アプリを完全に再起動** |
| `chatgpt-desktop` | ChatGPT デスクトップ | **コピー型**。編集したら `update` |
| `codex` | Codex CLI + ChatGPT デスクトップ | **コピー型**。編集したら `update` |
| `chatgpt-web` | ChatGPT Web の HTTP コネクタ | HTTPS 公開が必要 |
| `all` | `claude-code` + `codex` | |

### Claude Code

```bash
node scripts/install.mjs install claude-code
```

セッション中なら `/reload-plugins`。`/lab-assistant:find-schedule 次のゼミ` のように使います。

### Claude Desktop

```bash
node scripts/install.mjs install claude-desktop
```

`claude_desktop_config.json` に MCP を 3 つ登録します(既存の設定はバックアップされます)。
**アプリを完全に再起動**してください。

### ChatGPT デスクトップ

```bash
node scripts/install.mjs install chatgpt-desktop
```

アプリを再起動すると Settings → Plugins に `vdslab (local)` の lab-assistant が出ます。

> **コピー型**です。`~/.codex/plugins/cache/vdslab-local/` にスナップショットが作られ、
> **そこには `.env` のコピーが含まれます**。リポジトリを編集したら
> `node scripts/install.mjs update chatgpt-desktop` で入れ直してください。
> `uninstall` するとスナップショットごと削除されます。

### Codex CLI

```bash
node scripts/install.mjs install codex
```

検索スクリプトは外部 API を叩くため、codex 実行時にネットワーク許可が必要です:

```bash
codex -c 'sandbox_workspace_write.network_access=true'
```

---

## 6. アプリごとに「何が MCP として見えるか」

**ここは混乱しやすいので明記します。** アプリによって提供のされ方が違います。

| アプリ | MCP サーバー | 検索機能の出どころ |
| --- | --- | --- |
| Claude Code | `esa`, `seminar-calendar` の **2 つ** | スキルが `scripts/bin/search.mjs` を実行 |
| ChatGPT デスクトップ / Codex | `esa`, `seminar-calendar` の **2 つ** | 同上 |
| Claude Desktop | `lab-assistant`, `lab-assistant-esa`, `lab-assistant-seminar-calendar` の **3 つ** | `search_lab` / `find_expert` を **MCP ツール**として提供 |

**MCP が 2 つなのは正常です。** 理由:

- 横断検索(`search_lab` / `find_expert`)は `mcp-server/` にありますが、これは
  **ビルド成果物(`mcp-server/dist/`)が必要**で、git 管理外です。`.mcp.json` に入れると
  clone 直後(未ビルド)の環境で起動に失敗するため、あえて含めていません。
- Claude Code と ChatGPT デスクトップは**スキルからシェル経由で** `search.mjs` を呼べるので、
  MCP にする必要がありません。
- Claude Desktop は**スキルに対応していない**ため、そこだけ `mcp-server` を直接登録します。
  この場合はインストーラが自動でビルドします。

つまり `esa` / `seminar-calendar` の 2 つは「スキルでは代替しにくいもの」だけを MCP にしている、
という切り分けです。

> なお **esa 検索は MCP が無くても動きます**(v0.2.0 から)。`search.mjs` が esa API を直接叩くので、
> MCP が繋がらないセッションでも esa を検索できます。バンドルしている esa MCP は、
> 記事の作成・更新など検索以外の操作をしたいとき用です。

---

## 7. 使い方

スキルはスラッシュコマンドでも自然文でも起動します。

| コマンド | 用途 |
| --- | --- |
| `/lab-assistant:find-schedule <イベント>` | 「M2 中間報告会いつ?」— 日程を出典付きで答える |
| `/lab-assistant:search-lab <調べたいこと>` | 調べもの全般の入口。横断検索して要約 |
| `/lab-assistant:find-expert <トピック>` | 「MCP に詳しい人は?」— 根拠付きで人を探す |
| `/lab-assistant:check-shared <URL/話題>` | 週報ネタや共有が既出でないか確認 |
| `/lab-assistant:find-channel <話題>` | その話題のチャンネルを特定 |
| `/lab-assistant:add-event <url>` | Discord / esa の URL から予定を作成 |

CLI から直接使うこともできます:

```bash
node scripts/bin/search.mjs "可視化 ライブラリ" --since 2026-04-01 --text
node scripts/bin/find-expert.mjs "トーラス" --top 5 --text
```

検索語は**関連語に自動で広がります**(「ゼミ」→ セミナー / seminar / 研究会)。
広げたくないときは `--no-expand`、辞書に無い言い換えを足したいときは `--related 語1,語2`。

---

## 8. 更新する

```bash
cd lab-assistant
git pull
node scripts/install.mjs update <target>
```

- `claude-code` / `claude-desktop` は参照型なので、`git pull` だけでも反映されます
  (Claude Desktop はアプリ再起動、Claude Code は `/reload-plugins`)
- `chatgpt-desktop` / `codex` は**コピー型なので `update` が必須**です

---

## 9. 解除する

```bash
node scripts/install.mjs uninstall <target>
```

コピー型(`chatgpt-desktop` / `codex`)のスナップショットには **`.env` のコピーが含まれる**ため、
`uninstall` はキャッシュごと削除します。使わなくなったら解除しておくことを勧めます。

> `uninstall codex` は `chatgpt-desktop` と共有しているリンクも消します。
> ChatGPT デスクトップを残したい場合は、そのあと `install chatgpt-desktop` を実行してください。

---

## 10. うまくいかないとき

まず `node scripts/bin/check-setup.mjs` を実行してください。だいたいここで切り分けられます。

| 症状 | 原因と対処 |
| --- | --- |
| esa が 401 | `ESA_ACCESS_TOKEN` が無効か失効。PAT を再発行 |
| esa が 404 | そのチームにトークンがアクセスできない。`ESA_DEFAULT_TEAM` を確認 |
| Discord のメッセージが空 | **MESSAGE CONTENT INTENT** が OFF |
| Discord で「権限が無いチャンネル N 件」 | Bot ロールに `チャンネルを見る` / `メッセージ履歴を読む` を付与 |
| Drive が 403(スコープ不足) | `node scripts/bin/auth-google.mjs --write` を再実行(`drive.readonly` が要る) |
| Drive が 403(API 未有効) | Cloud Console で Drive API を有効化。反映に数分かかる |
| GitHub がスキップされる | `GITHUB_TOKEN` 未設定。`check-github-token.mjs` で確認 |
| 検索が 0 件 | 期間(`--since`)を広げる / 語を減らす / `--related` で言い換えを足す |
| 検索が多すぎる | `--no-expand` で完全一致寄りにする / 語を足して AND を強める |
| ChatGPT デスクトップに出ない | `codex plugin list` の STATUS を確認。`not installed` なら `install chatgpt-desktop`。アプリの再起動も必要 |
| 変更が反映されない | コピー型(`chatgpt-desktop` / `codex`)は `update` が必要 |

---

## 11. セキュリティ上の注意

- **`.env` は git 管理外**です(`.gitignore` 済み)。コミットしないでください。
- コピー型で導入すると **`.env` のコピーがキャッシュに作られます**。解除時に削除されます。
- このプラグインは Discord / esa / Drive など**他人が書いた文章を読み込みます**。
  本文に「〜しろ」と書かれていても指示として扱わないよう、スキル側で調査専用の手順にしていますが、
  読み込んだ内容を鵜呑みにしないでください。
- 書き込みを伴うのは **ゼミカレンダーへの予定作成のみ**です。Drive は読み取り専用、
  esa / Slack / Discord / GitHub は検索のみで、既存の資料を書き換える経路はありません。
