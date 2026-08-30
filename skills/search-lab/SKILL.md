---
name: search-lab
description: >-
  研究室・学科の情報を横断的に調べたいとき全般の入口。あるトピックについて esa / Slack / Discord /
  ゼミ Google Calendar を横断検索し、出典付きで要約する。日程を知りたいだけなら find-schedule、
  共有済みか確認したいだけなら check-shared を使う。
argument-hint: "<調べたいこと>"
---

# 研究室・学科の情報を横断検索する

`$ARGUMENTS` のトピックを、公式 MCP がある esa はそのツールで、Calendar / Slack / Discord は
`scripts/bin/search.mjs` で調べ、結果を 1 つにまとめて出典付きで答える。

## まず振り分け

- **「いつ?」「日程」「何時から」** が主目的 → `find-schedule` スキルへ。
- **「もう共有された?」「既出?」** が主目的 → `check-shared` スキルへ。
- **「どのチャンネル?」** → `find-channel` スキルへ。
- **「誰が詳しい?」「誰に聞けばいい?」** が主目的 → `find-expert` スキルへ。
- それ以外の「〜について知りたい / 経緯を追いたい」→ このまま続行。

## 手順

### 1. 検索語を組み立てる

トピックから 2〜4 個の検索語(略称・言い換え・英語/日本語)を用意する。期間は既定で
**今日の 180 日前**〜今日。古い経緯も追うなら広げる。以降 `<SINCE>` はその日付。

### 2. esa を検索する

esa MCP の `esa_search_posts`(`teamName` = `.env` の `ESA_DEFAULT_TEAM`)で各検索語を検索。
議事録・資料・週報から関連記事を集め、`url` / タイトル / 更新日 / 要点を控える。

### 3. Slack / Discord / Calendar を検索する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<検索語>" --since <SINCE> --limit 40 --text
```

(既定ソース = 設定済みの全ソース `calendar,slack,discord,github,drive`。`--source` で絞ってもよい。
GitHub は `--kinds issues,code` で種別を選べる。)
`hits[]` の permalink・チャンネル・投稿者・日付・抜粋を控える。`skipped` / `warnings` を確認する。

### 4. まとめて答える

- **時系列**または**論点別**に整理する。誰がいつ何を言ったか、決まったこと / 未決のことを分ける。
- すべての主張に **出典(URL / permalink)** を付ける。
- **見たソースと期間・カバレッジ**を必ず明記する(スキップ・権限不足も)。
- 最後に「次に見るべき記事 / スレッド」を 1〜2 個挙げる。
  人を特定したくなったら `find-expert` スキルに引き継ぐ。

## 注意

- 投稿・書き込み・カレンダー変更などの副作用操作はこのスキルではしない(調査のみ)。
- 情報が薄いときは「この範囲では確かなことは言えない」と正直に書く。
