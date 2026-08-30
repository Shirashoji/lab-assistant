# lab-assistant MCP サーバー

`lab-assistant` のコアロジック（`../scripts/lib/`）を **MCP ツール**として公開します。
Claude Code プラグインを読み込めないクライアント（**ChatGPT** のカスタムコネクタ、
**OpenAI Codex CLI**、**Claude Desktop** など）から同じ機能を使うためのものです。

Claude Code で使うだけなら不要です（プラグイン本体の `/lab-assistant:add-event` を使ってください）。

## 公開ツール

| ツール | 種別 | 対応する bin スクリプト |
| --- | --- | --- |
| `collect_context` | read | `scripts/bin/collect-context.mjs` |
| `find_duplicate_events` | read | `scripts/bin/find-duplicate.mjs` |
| `create_event` | write | `scripts/bin/create-event.mjs` |

ロジックは `scripts/lib/{collect,dedupe,gcal}.mjs` を直接呼んでおり、プラグイン／bot と完全に共通です。

## 認証情報

esa / Discord / Google の認証は **親ディレクトリ `../` の `.env`**（`lab-assistant` 本体）を読みます。
先にそちらのセットアップ（`../README.md`）を済ませてください。
ホスティング環境では `.env` の代わりに環境変数を設定できます（環境変数が優先）。

MCP サーバー固有の設定は `mcp-server/.env`（`.env.example` 参照）:

| キー | 説明 |
| --- | --- |
| `PORT` | HTTP 版の待受ポート（既定 8787） |
| `MCP_AUTH_TOKEN` | 設定すると `/mcp` に `Authorization: Bearer <値>` を要求 |

## 起動

```bash
cd mcp-server
npm install
npm run build             # dist/ を生成 (start:* は dist を実行)

# stdio 版（Codex CLI / Claude Desktop / claude mcp add 用）
npm run start:stdio

# Streamable HTTP 版（ChatGPT / リモート用）
npm run start:http        # → http://localhost:8787/mcp

# 開発時 (ビルド不要・監視)
npm run dev:http
```

> ほとんどの場合は手動ではなく `node ../scripts/install.mjs <target>` を使ってください
> （依存インストール・ビルド・各アプリへの登録をまとめて実行）。

## クライアント別の接続

### OpenAI Codex CLI

`~/.codex/config.toml`（先に `npm run build` 済みであること）:

```toml
[mcp_servers.lab-assistant]
command = "node"
args = ["/ABS/PATH/lab-assistant/mcp-server/dist/stdio.js"]
```

### Claude Desktop / `claude mcp add`

Claude Desktop アプリは `node ../scripts/install.mjs claude-desktop` が自動でやります。手動なら:

```bash
claude mcp add lab-assistant -- node /ABS/PATH/lab-assistant/mcp-server/dist/stdio.js
```

### ChatGPT（カスタムコネクタ）

HTTP 版を公開 HTTPS にして接続します。手順は [`../CHATGPT.md`](../CHATGPT.md) を参照。

## 動作確認

```bash
# HTTP 版を起動した状態で
curl -s http://localhost:8787/

# tools/list（初期化 → セッション ID 取得 → 一覧）
# 詳細な JSON-RPC 手順は CHATGPT.md の「疎通確認」を参照
```
