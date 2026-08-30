---
name: find-schedule
description: >-
  「次のゼミはいつ?」「M2 の中間報告会っていつ?」「発表会の日程は?」「先生ミーティング何時から?」
  のように研究室・学科のイベント日程を知りたいときに使う。情報が Discord / Slack / esa / Google
  Calendar のどこにあるか分からなくても横断して探し、出典付きで答える。見つかった予定がゼミの
  Google Calendar に無ければ追加を提案する。
argument-hint: "<探したいイベント(例: M2 中間報告会)>"
---

# 研究室・学科イベントの日程を横断検索する

散在する情報を統合し、最も確実で最新のイベント日程を **出典付き** で答える。
公式 MCP がある esa はそのツールを、Calendar / Slack / Discord は `scripts/bin/search.mjs` を使う。

## 前提

- `node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/check-setup.mjs"` が主要項目 ✅ であること。
  未設定のソースは自動でスキップされるが、その事実は回答に明記する。
- esa MCP のツール(`esa_search_posts` など)が使えること。使えない場合は `.mcp.json` の
  `esa` サーバーが登録されているか(`/mcp`)を確認するようユーザーに促す。

## 手順

### 1. 何を探すかを確定する

`$ARGUMENTS` からイベント名・キーワードを取る。曖昧なら「どのイベントか」「いつ頃の話か」を一度だけ聞く。
今日の日付とタイムゾーン `Asia/Tokyo` を基準にする。特に断りがなければ **未来の予定** を答える
(「前回の〜」なら直近の過去)。

検索期間の下限は、通常は **今日の 90 日前**。年度をまたぐイベント(中間発表・修論審査など)は
**180 日前** にする。以降 `<SINCE>` はこの日付(`YYYY-MM-DD`)を指す。

### 2. ゼミの Google Calendar を最優先で確認する

**`seminar-calendar` MCP の `search_events`**(`plugin:lab-assistant:seminar-calendar`)を使う。
引数 `{ query: "<イベント名>" }`。このサーバーは `.env` の `GOOGLE_CALENDAR_ID`(= ゼミカレンダー)
だけを見る。**Claude アプリ標準の Google Calendar コネクタは使わない**(別カレンダーを参照してしまうため)。

MCP が使えない場合のフォールバック:
`node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<イベント名>" --source calendar --limit 10 --text`

- ヒットしたら日時・タイトル・場所・説明・`htmlLink` を控える。ただしここで止めず、手順 3〜4 で
  裏取り(場所・時刻の変更が別ソースに出ていないか)をする。

### 3. esa の議事録・資料を確認する

esa MCP の `esa_search_posts` を使う。`teamName` は `.env` の `ESA_DEFAULT_TEAM`
(不明なら `esa_get_teams` で確認)。クエリ例:

- `<イベント名>`
- `<イベント名> 日程` / `次回 <イベント名>`
- `議事録 <イベント名>` / `先生ミーティング`

直近の議事録の「次回の予定」「持ち物」「宿題」欄と、`<イベント名>` を含む資料記事を読む。
記事の `url` と更新日を控える。

### 4. Slack / Discord の直近アナウンスを確認する

リスケ・会場変更・時間変更が直前に出ていることがある。学科の予定(M2 中間報告会・修論審査会・
ガイダンスなど)は **Slack** に、ゼミ内の連絡は **Discord** にあることが多い。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<イベント名>" --source slack,discord --since <SINCE> --limit 20 --text
```

必要なら語を変えて再検索(`<イベント名> リスケ` / `<イベント名> 会場` / `<略称>` など)。
`skipped` にソースが出ていたら、そのソースは見られていないことを回答に書く。

### 5. 統合して回答する

- **見たソースを必ず列挙**(ヒット無しでも「Calendar / esa / Slack / Discord を確認」と書く)。
- ソース間で日時・場所が食い違うときは **タイムスタンプが新しい方を採用**し、両方を提示する。
- 相対表現は絶対日時に直す。曜日も添える。
- 例:
  > **M2 中間発表会: 2026-09-11(木)〜12(金) 学科演習室**(Slack #2025-大学院 / 尾崎先生 2026-07-03)
  > 発表 15 分 + 質疑 15 分。プログラム(暫定版)は 9/4 に共有されています。
  > ゼミの Google Calendar には未登録です。

### 6. ゼミカレンダーに無ければ追加を提案する

手順 2 でゼミ Google Calendar に該当予定が **無く**、他ソースで日時が確定できた場合のみ:

> この予定はゼミのカレンダーに入っていません。追加しますか?

承認されたら `seminar-calendar` MCP で:
1. `find_duplicate_events { summary, start }` で重複候補を確認(同一と判断できる候補があれば作成しない)
2. 無ければ `create_event { summary, start, end?, location?, description }` で作成。
   `description` 末尾に `Source: <URL>(ソース名)` を必ず入れる。

承認が無ければ作成しない。日時が曖昧なら追加しない(ユーザーに確認)。
(MCP が使えない場合は `add-event` スキルの手順 5 = `bin/find-duplicate.mjs` → `bin/create-event.mjs`。)

## 注意

- 過去の日程を未来の予定として答えない。
- このスキルでは予定の **変更・削除はしない**(確認と、新規追加の提案のみ)。
- 個人の予定・DM は対象にしない。
