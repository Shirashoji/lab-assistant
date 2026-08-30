# lab-assistant-search（Slack アプリ）

学科ワークスペースを検索するための **最小構成の Slack アプリ**。
ワークスペース検索(`search.messages`)は **ユーザートークン限定**(Bot トークン不可)なので、
`oauth_config.scopes.user` に `search:read` だけを持つアプリを作り、User OAuth Token を得る。

## 構成

| ファイル | 役割 |
| --- | --- |
| `manifest.json` | アプリ定義(user スコープ: `search:read` / `users:read` / `channels:read` / `groups:read`) |
| `.slack/hooks.json` | Slack CLI の `get-manifest` フック |
| `.slack/get-manifest.mjs` | `manifest.json` をそのまま出力するだけのフック実装(依存ゼロ) |

`.slack/apps.json` / `apps.dev.json` / `cache/` / `config.json` は Slack CLI が生成するローカル状態で
`.gitignore` 済み。

## インストール手順

[Slack CLI](https://docs.slack.dev/tools/slack-cli/) を導入して:

```bash
slack login                       # ワークスペースに CLI をログイン(初回のみ)
cd slack-app
slack manifest validate
slack app install --team <TEAM_ID> --environment deployed
```

`slack auth list` で `Team ID` を確認できる。インストールに管理者承認が要る場合は
その場で「リクエストを送信」する。

## トークンの取得

Slack CLI はアプリの `xoxp-` トークンをコマンドラインに出さないので、Web で取得する:

1. `slack app settings` か <https://api.slack.com/apps> でこのアプリを開く
2. **OAuth & Permissions** → **User OAuth Token**(`xoxp-...`)をコピー
3. リポジトリルートの `.env` の `SLACK_USER_TOKEN` に貼る
4. `node scripts/bin/check-setup.mjs` で「Slack 接続 ✅」を確認

`search:read` を後から足した場合は **Reinstall to Workspace** が必要。

## スコープを変えるには

`manifest.json` を編集 → `slack manifest validate` → `slack app install` で再インストール。
