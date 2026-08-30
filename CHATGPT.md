# ChatGPT で使う

`lab-assistant` は Claude Code プラグインですが、コアロジックは MCP サーバー
（[`mcp-server/`](mcp-server/)）としても公開しているので、ChatGPT からも同じことができます。

> **共通のセットアップ**（Discord Bot / esa トークン / Google OAuth / `.env`）は
> [README.md](README.md) を参照してください。このページは **ChatGPT 固有の手順**だけを扱います。

---

## 前提: ChatGPT の「プラグイン」とは

ChatGPT で「プラグイン」と呼ばれているものは、2026 年 7 月のリネームで
**旧「コネクタ」= カスタム MCP サーバー**を指すようになりました
（Settings → Apps →（開発者モード）→ カスタムコネクタ）。

- Claude Code のプラグイン形式（`plugin.json` / `SKILL.md` / `marketplace.json`）を
  **ChatGPT がそのまま読み込む仕組みはありません**。
- ChatGPT から使うには、このリポジトリの **MCP サーバーを公開 HTTPS で動かして**
  カスタムコネクタとして登録します。

### 必要なもの

| 項目 | 内容 |
| --- | --- |
| ChatGPT プラン | Plus / Pro / Business / Enterprise / Education（管理ワークスペースは管理者が「カスタムコネクタ」を許可している必要あり） |
| サーバー | **リモートの公開 HTTPS エンドポイント**。SSE または Streamable HTTP。ChatGPT は localhost・社内ネットワークに到達できません |
| 公開手段 | `cloudflared` / `ngrok` などのトンネル、または任意の PaaS |
| 認証 | OAuth / 認証なし。本サーバーは「認証なし ＋ 推測困難なトンネル URL」または「Bearer トークン（下記）」を想定 |

参考: [Developer mode and MCP apps in ChatGPT](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt) ／ [Build with the Apps SDK](https://help.openai.com/en/articles/12515353-build-with-the-apps-sdk)

---

## 手順

### 1. 共通セットアップを済ませる

[README.md](README.md) に従って `lab-assistant/.env` に Discord / esa / Google の認証情報を入れ、
`node scripts/bin/check-setup.mjs` がすべて ✅ になる状態にします。

### 2. MCP サーバーを起動

インストーラを使うと、依存インストール・ビルド・`MCP_AUTH_TOKEN` 生成・手順表示までまとめて行えます:

```bash
node scripts/install.mjs chatgpt --serve
```

手動でやる場合:

```bash
cd mcp-server
npm install && npm run build
cp .env.example .env        # 必要なら PORT / MCP_AUTH_TOKEN を編集
npm run start:http          # → http://localhost:8787/mcp
```

- esa / Discord / Google の認証は自動で `../.env`（lab-assistant 本体）を読みます。
- **推奨**: `mcp-server/.env` の `MCP_AUTH_TOKEN` に長いランダム文字列を設定
  （`openssl rand -hex 32`）。設定すると `/mcp` へのアクセスに
  `Authorization: Bearer <値>` が必須になります。

### 3. 公開 HTTPS にする（cloudflared の例）

```bash
# 別ターミナルで
brew install cloudflared            # 未インストールなら
cloudflared tunnel --url http://localhost:8787
```

表示された `https://xxxx-xxxx.trycloudflare.com` が公開 URL です。
ChatGPT に渡すエンドポイントは **`https://xxxx-xxxx.trycloudflare.com/mcp`**。

> `trycloudflare.com` の URL は起動ごとに変わります。常設するなら
> 名前付きトンネル（`cloudflared tunnel create`）や固定ドメインの PaaS を使ってください。

### 4. ChatGPT にカスタムコネクタを追加

1. ChatGPT（Web）→ **Settings → Apps → Advanced settings** で **Developer mode** を ON
   （バージョンによっては **Connectors → Advanced**。「Connectors」は現在「Plugins」表記）。
2. **Apps（Plugins）→ カスタムコネクタを追加**。
3. 入力:
   - **Name**: `lab-assistant`
   - **MCP Server URL**: `https://xxxx.trycloudflare.com/mcp`
   - **Authentication**:
     - `MCP_AUTH_TOKEN` を設定した場合 → 「API key / Bearer」を選び、その値を入力
       （UI にトークン欄が無いバージョンでは「認証なし」を選び、トンネル URL の秘匿で運用）
     - 設定しない場合 → 「認証なし」
4. 保存すると `collect_context` / `find_duplicate_events` / `create_event` の 3 ツールが見えます。

### 5. 使う

チャットで開発者モードのツールを有効にし、次のように依頼します。

```
このメッセージの予定を Google カレンダーに追加して。すでにあれば作らないで。
https://discord.com/channels/123/456/789
```

```
この esa の日程をカレンダーに入れて:
https://myteam.esa.io/posts/1234
```

ChatGPT の動き:

1. `collect_context` に URL を渡して本文・返信・スレッド・esa リンクを取得
2. 本文から予定（タイトル / 日時 / 場所）を判断
3. `find_duplicate_events` で重複を確認
4. 重複が無ければ `create_event`。あれば「作成済み」とカレンダーリンクを返す

> `create_event` は書き込みツールなので、ChatGPT が実行前に確認を挟みます。

---

## 疎通確認（任意）

```bash
# initialize（セッション ID を取得）
curl -s -D - -o /dev/null -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  ${MCP_AUTH_TOKEN:+-H "Authorization: Bearer $MCP_AUTH_TOKEN"} \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 上の応答ヘッダ mcp-session-id を使って tools/list
curl -s -X POST http://localhost:8787/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <取得した ID>' \
  ${MCP_AUTH_TOKEN:+-H "Authorization: Bearer $MCP_AUTH_TOKEN"} \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

---

## トラブルシューティング

| 症状 | 対処 |
| --- | --- |
| コネクタ追加後にツールが出ない | 開発者モードが ON か / ワークスペースがカスタムコネクタを許可しているか / URL 末尾が `/mcp` か |
| 401 Unauthorized | `MCP_AUTH_TOKEN` とコネクタ側のトークンが一致しているか |
| `collect_context` が `warnings` を返す | Bot が対象 Discord サーバーに未参加 / チャンネル権限不足 / MESSAGE CONTENT INTENT 未有効 / esa トークンのチーム違い。`node scripts/bin/check-setup.mjs` で切り分け |
| `create_event` が失敗 | `GOOGLE_REFRESH_TOKEN` 失効 → `node scripts/bin/auth-google.mjs` で再取得 |
| トンネル URL が毎回変わる | 名前付き cloudflared トンネルか固定ドメインの PaaS を使う |

---

## 代替: OpenAI Codex CLI（トンネル不要）

ChatGPT アプリではなく **Codex CLI** を使うなら、公開もトンネルも不要で、
stdio 版の MCP サーバーをローカル接続できます。

```bash
cd mcp-server && npm install && npm run build
```

```toml
# ~/.codex/config.toml
[mcp_servers.lab-assistant]
command = "node"
args = ["/ABS/PATH/lab-assistant/mcp-server/dist/stdio.js"]
```

以降、Codex に「この Discord / esa の URL の予定をカレンダーに追加して」と頼めば
同じ 3 ツールを使って動きます。詳細は [mcp-server/README.md](mcp-server/README.md)。
