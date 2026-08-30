---
name: check-shared
description: >-
  記事・データ可視化(Visualization)・ツールなどを研究室に共有する前に、すでに esa / Discord / Slack で
  誰かが(または自分が過去に)共有・紹介していないか確認したいときに使う。週報で「面白い Visualization」を
  紹介する前の重複チェックにも使う。
argument-hint: "<共有予定の URL またはトピック>"
---

# 共有前の重複チェック

> 🚧 **下書き**(Phase 3)。

## 目的

情報の重複共有を防ぐ。すでに共有・議論されていれば、そのスレッド/記事を案内する。

## 手順

### 1. 対象を受け取る

`$ARGUMENTS` から URL とトピックを取る。URL があれば:
- クエリパラメータを除いた**ベース URL** も控える(検索漏れ防止)。
- タイトル・ドメイン・著者・手法名(例「Sankey」「アニメーション地図」)など**複合キーワード**を作る。
短すぎる単語だけの検索はしない(ノイズになる)。

### 2. esa を検索する

esa 公式 MCP の `esa_search_posts`(`plugin:lab-assistant:esa`、`teamName` は `.env` の
`ESA_DEFAULT_TEAM`)で URL / ベース URL / キーワードを検索。一致記事の URL・タイトル・投稿者・日付を控える。

### 3. Slack を検索する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<複合キーワード>" --source slack --since <90日前> --text
```

一致メッセージの permalink・チャンネル・投稿者・日付を控える。`SLACK_USER_TOKEN` 未設定なら
skipped に出るので、その旨を回答に明記する。

### 4. Discord を検索する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<複合キーワード>" --source discord --since <90日前> --text
```

週報・共有・雑談などのチャンネルの一致メッセージのリンク・投稿者・日付を控える。

### 5. 「自分が過去に紹介済みか」を確認する(週報 Visualization 用)

投稿者を**自分**に絞って手順 2〜4 を再度確認する。週報チャンネルの過去の自分の投稿に
同じ Visualization / 同じ出典が無いかを見る。

### 6. 報告する

- **重複あり**:
  > すでに共有されています: [Slack #visualization] 〇〇さんが 2026-07-12 に投稿
  > (permalink)
- **自分が紹介済み**:
  > これは自分が週報で 2026-05-30 に紹介済みです(Discord リンク)。別のネタを検討してください。
- **重複なし**:
  > esa / Slack / Discord を検索しましたが見つかりませんでした。共有して問題なさそうです。

どのソース・どの範囲を見たかを必ず書く。
