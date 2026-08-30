---
name: check-shared
description: >-
  記事・データ可視化(Visualization)・ツール・論文などを研究室に共有する前に、すでに esa / Slack /
  Discord / GitHub / Google Drive で誰かが共有・議論していないか確認したいときに使う。毎週の週報で
  「今週見た面白い Visualization」を紹介する前に、自分が過去に同じものを紹介していないかの
  チェックにも使う。
argument-hint: "<共有予定の URL またはトピック>"
---

# 共有前の重複チェック

情報の重複共有を防ぐ。すでに共有・議論されていれば、そのスレッド / 記事を出典付きで案内する。

## 手順

### 1. 対象を受け取り、検索語を組み立てる

`$ARGUMENTS` から URL とトピックを取る。

- URL があれば **クエリパラメータを除いたベース URL** も控える(`?utm=...` などで一致が漏れる)。
- 検索語の候補を 2〜4 個作る: **記事タイトル**の特徴的な語 / **ドメイン**(例 `observablehq.com`)/
  **著者名** / **可視化の手法・題材名**(例「サンキー」「路線図」「人口ピラミッド」)。
- 1 語だけの短いクエリは避け、複合語にする。

以降 `<SINCE>` は既定で **今日の 120 日前**(`YYYY-MM-DD`)。週報ネタの自己チェックは
学期をまたいで見たいので **240 日前** にする。

### 2. esa を検索する

esa MCP の `esa_search_posts`(`teamName` = `.env` の `ESA_DEFAULT_TEAM`)で、URL・ベース URL・
各検索語を順に検索。特に **週報カテゴリ**(`週報/...`)の記事に同じ URL / 題材が無いか見る。
一致したら記事 URL・タイトル・投稿者(`screen_name`)・更新日を控える。

### 3. Slack を検索する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<検索語>" --source slack --since <SINCE> --limit 20 --text
```

URL でも 1 回検索する(`--` 無しでそのまま渡す)。一致メッセージの permalink・チャンネル名・
投稿者・日付を控える。

### 4. Discord を検索する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<検索語>" --source discord --since <SINCE> --limit 20 --text
```

週報・共有・可視化・雑談系のチャンネルのヒットを見る。`coverage` / `warnings` に
「権限無しで除外 N 件」が出たら、見られていない範囲があることを回答に添える。

### 4.5 GitHub / Google Drive も見る(該当しそうなときだけ)

- **ツール・ライブラリ・実装**の共有なら GitHub を見る。すでに誰かが取り込んでいるかもしれない。

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<検索語>" --source github --kinds issues,code --limit 20 --text
  ```

- **資料・スライド**の共有なら Drive を見る。

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<検索語>" --source drive --since <SINCE> --limit 20 --text
  ```

どちらも未設定ならスキップされる(`skipped` に出る)。無理に全部見る必要はないが、
**見なかったソースは回答に書く**こと。

Drive のヒットが「同じものを共有済みか」の判断に足りない(タイトルだけでは分からない)ときは、
そのファイルを落として中身を読む。Google スライドは PDF に変換されるので Read で読める。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/drive-fetch.mjs" "<Drive の URL か fileId>" --text
```

出力の `保存先:` のパスを Read で読む。落とすのは判断に必要な 1〜2 件だけにとどめる。
出力の最後の行が「Read では読めません」と言っていたら従うこと(`.pptx` などの Office 形式)。
このスクリプトは読み取り専用で、Drive 側を変更することはない。

### 5. 自分が過去に紹介済みかを確認する(週報 Visualization 用)

トピックが「週報で紹介する Visualization」なら、手順 2〜4 のヒットの中に **自分の投稿**が無いかを
必ず確認する。無ければ、自分の名前 + 題材で軽く追加検索する(例
`--source slack,discord "<自分の表示名> <手法名>"`)。過去の週報記事(esa)の自分のセクションも見る。

### 6. 報告する

- **重複あり**:
  > すでに共有されています — Slack #visualization で ◯◯ さんが 2026-07-12 に投稿。
  > https://.../archives/...
- **自分が過去に紹介済み**:
  > これは自分が 2026-05-30 の週報で紹介済みです(esa: 週報/2026/22/...)。別のネタが良さそうです。
- **重複なし**:
  > esa / Slack / Discord(過去 <日数> 日)を確認しましたが見つかりませんでした。共有して大丈夫そうです。

- **誰が詳しいか**まで知りたくなったら `find-expert` スキルに引き継ぐ。

**見たソースと期間・範囲を必ず書く**。`SLACK_USER_TOKEN` 未設定などでスキップしたソースも明記する。

## 注意

- 断定しすぎない。「見つからなかった = 存在しない」ではないので、検索範囲を添えて伝える。
- 何かを投稿・共有する操作はこのスキルではしない(調査のみ)。
