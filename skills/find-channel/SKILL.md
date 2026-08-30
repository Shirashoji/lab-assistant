---
name: find-channel
description: >-
  「◯◯について話しているチャンネルはどこ?」「△△の相談ってどのチャンネルでやってる?」のように、
  ある話題が扱われている Discord / Slack のチャンネルを特定したいときに使う。
argument-hint: "<話題(例: 就活情報 / GPU サーバー / 発表練習)>"
---

# 話題からチャンネルを特定する

トピックに一致するメッセージを横断検索し、**どのチャンネルで・どのくらい活発に**話されているかを
集計して答える。

## 手順

### 1. 検索語を決める

`$ARGUMENTS` から話題を取り、言い換えを 2〜3 個用意する(例「GPU」「サーバー」「計算機」)。

### 2. Slack と Discord を検索する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<話題>" --source slack,discord --since <今日の180日前> --limit 60
```

JSON の `hits[]` を使う。各ヒットの `extra.channelName` / `source` を集計する。

### 3. チャンネル別に集計して答える

- `channelName` ごとにヒット件数と最新の日付を数える。件数が多い / 最近も続いている順に並べる。
- 各チャンネルについて「代表的なメッセージ 1 件」の要約とリンクを添える。
- 例:
  > **#gpu-server(Slack, 直近 12 件)** — 空き状況の共有や予約の相談。最新 2026-08-20。
  > https://.../archives/...
  > #tech-雑談(Discord, 3 件)— たまに話題に出る程度。

### 4. 補足

- ヒットが割れて決め手が無いときは、上位候補を複数提示する。
- 権限が無くて見えていないチャンネルがある場合(`warnings` / `coverage` に出る)はその旨を添える。
- `SLACK_USER_TOKEN` / `DISCORD_BOT_TOKEN` 未設定のソースはスキップされる。回答に明記する。
