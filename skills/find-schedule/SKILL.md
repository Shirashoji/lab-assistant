---
name: find-schedule
description: >-
  「次のゼミはいつ?」「M2 の中間報告会っていつ?」「発表会の日程は?」のように、研究室のイベント日程を
  知りたいときに使う。情報が Discord / Slack / esa / Google Calendar のどこにあるか分からなくても横断して探す。
  見つかった予定がゼミの Google Calendar に無ければ、追加するか確認する。
argument-hint: "<探したいイベント(例: 中間報告会)>"
---

# 研究室イベントの日程を横断検索する

> 🚧 **下書き**(Phase 3)。全体像は [docs/ROADMAP.md](../../docs/ROADMAP.md)。

## 目的

散在する情報を統合し、最も確実で最新のイベント日程を、**出典付き**で答える。

## 手順

### 1. 何を探すかを確定する

`$ARGUMENTS` からイベント名・キーワードを取る。曖昧なら「どのイベントか」「いつ頃の話か」を聞く。
今日の日付(`Asia/Tokyo`)を基準に、**未来の予定のみ**を対象にする。

### 2. ゼミの Google Calendar を最優先で確認する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<イベント名>" --source calendar --text
```

`search.mjs` の calendar ソースは `.env` の `GOOGLE_CALENDAR_ID`(= ゼミカレンダー)だけを見る。
**Claude アプリ標準の Google Calendar コネクタは使わない**(別カレンダーを見てしまうため)。

- 見つかった → 日時・タイトル・場所・説明を控える。手順 5 へ。

### 3. esa の議事録を確認する

esa 公式 MCP のツール `esa_search_posts`(`plugin:lab-assistant:esa`)で
「次回ゼミ」「議事録」「<イベント名>」などを検索する。`teamName` は `.env` の
`ESA_DEFAULT_TEAM`(不明なら `esa_get_teams` で確認)。直近記事の「次回の予定」記述を探す。

### 4. Slack / Discord の直近アナウンスを確認する

リスケや変更連絡が直前に出ている可能性がある。学科の予定(M2 中間報告会など)は Slack 側にあることが多い。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<イベント名> 日程 リスケ" --source slack,discord --since <60日前> --text
```

`SLACK_USER_TOKEN` 未設定なら slack はスキップされる(結果の `skipped` に出る)。その旨を回答に明記する。

### 5. 統合して回答する

- どのソースを見たかを必ず明記する(見つからなかった場合も「Calendar / esa / Discord / Slack を確認」と書く)。
- ソース間で日時・場所が食い違うときは、タイムスタンプの新しい方を優先し、両方提示する。
- 例:
  > **中間報告会: 2026-09-18(金)13:00〜**(ゼミ Google Calendar より)
  > Discord の 9/10 のアナウンスでは会場が B301 に変更されています。

### 6. カレンダーに無ければ追加を提案する

手順 2 でゼミ Google Calendar に該当予定が **無く**、他ソースで日程が確定できた場合:

> この予定はゼミのカレンダーに入っていません。追加しますか?

承認されたら `add-event` スキルの「重複チェック → 作成」手順に渡す(`find-duplicate.mjs` →
`create-event.mjs`、出典を `description` 末尾に記載)。承認が無ければ作成しない。

## 注意

- 過去の日程を誤って答えない。
- 予定の変更・削除はしない(確認と、新規追加の提案のみ)。
