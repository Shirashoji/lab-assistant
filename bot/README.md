# calendar-agent Discord Bot（追加コンポーネント）

予定が書かれた Discord メッセージに**返信 + Bot へメンション**すると、
`calendar-agent` プラグインの `add-event` スキルを Claude Agent SDK 経由で実行し、
Google Calendar に予定を作成して結果を返信します。

この Bot は必須ではありません。まずはプラグイン本体（`/calendar-agent:add-event`）だけで運用できます。

## 仕組み

```
返信+メンション
   │
   ▼
bot/src/index.ts  ── 返信先の Discord メッセージ URL と本文中の esa リンクを収集
   │
   ▼
bot/src/runAgent.ts ── query() で Claude を起動（plugins に Calendar-agent を渡す）
   │
   ▼
add-event スキル ── collect-context → 抽出 → find-duplicate → create-event
   │
   ▼
結果を message.reply()
```

抽出・重複チェック・予定作成のロジックはプラグイン側と完全に共通です。

## セットアップ

1. 先に親ディレクトリ（`../`）の `calendar-agent` プラグインのセットアップを完了させる
   （`../.env` に Discord / esa / Google の認証情報が入っている状態）。
2. 依存をインストール:
   ```bash
   cd bot
   npm install
   ```
3. `.env` を用意:
   ```bash
   cp .env.example .env
   ```
   | キー | 説明 |
   | --- | --- |
   | `DISCORD_BOT_TOKEN` | プラグインと同じ Bot Token |
   | `ALLOWED_GUILD_IDS` | 応答を許可するサーバー ID（カンマ区切り、空なら全部） |
   | `ANTHROPIC_API_KEY` | Anthropic API キー |
   | `PLUGIN_ROOT` | `calendar-agent` プラグインの絶対パス（既定はこの `bot/` の 1 つ上） |
4. Bot の権限: `View Channels` / `Read Message History` / `Send Messages`。
   Developer Portal で **MESSAGE CONTENT INTENT** を ON。
5. 起動:
   ```bash
   npm run dev   # 開発（ファイル監視）
   npm start     # 通常起動
   ```

## 使い方

1. 誰かが予定を投稿（1 通でも、複数に分割でも、esa リンクだけでも可）。
2. そのメッセージに返信し、本文で Bot をメンション（例: `@calendar-agent お願い`）。
3. Bot が予定を作成し、「📅 予定を追加しました …」または「✅ この予定は作成済みです …」＋
   カレンダーリンクを返信します。

## 注意

- `permissionMode: "bypassPermissions"` で Claude を実行します。信頼できるサーバーだけを
  `ALLOWED_GUILD_IDS` に入れてください。
- Bot は Google カレンダーへの「作成」と「重複チェック」しか行いません（削除・変更なし）。
