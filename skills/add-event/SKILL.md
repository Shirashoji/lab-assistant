---
name: add-event
description: >-
  Discord のメッセージ URL や esa の記事 URL を渡されて、その内容から Google Calendar に予定を追加したいときに使う。
  「このメッセージの予定を入れて」「この esa の日程をカレンダーに」なども対象。返信チェーン・スレッド・
  前後に分割されたメッセージ・メッセージ内の esa リンクもまとめて読む。既にある予定は重複作成しない。
argument-hint: "<discord-or-esa-url> [url ...]"
---

# Discord / esa → Google Calendar

渡された URL の内容を読み取り、Google Calendar に予定を作成する。入力パターンは 3 つ:

- Discord メッセージ URL のみ
- esa 記事 URL のみ
- 両方（複数 URL を並べて渡す / または Discord メッセージ本文に esa リンクが含まれる → 自動で両方読む）

## 手順

### 1. 入力 URL を集める

`$ARGUMENTS` から URL をすべて抽出する。URL が 1 つも無ければユーザーに聞く。
`$ARGUMENTS` に「時間は19時から」等の補足指示があれば後段の抽出で考慮する。

### 2. 文脈を収集する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/collect-context.mjs" "<url1>" "<url2>" ...
```

- stdout の JSON を読む。`sources[]` に Discord バンドル（`type:"discord"`）と esa 記事（`type:"esa"`）が入る。
- 終了コードが 1（`sources` が空）またはエラーの場合は、`warnings` の内容から原因を推測してユーザーに伝えて停止する。よくある原因:
  - Discord: Bot が対象サーバーに未参加 / チャンネル閲覧・メッセージ履歴の権限不足 / トークン無効 / MESSAGE CONTENT INTENT 未有効
  - esa: トークン無効 / そのチームにアクセスできない / 記事番号ちがい
- `warnings` があれば結果に添える（部分的に取得できていれば続行してよい）。

### 3. 予定情報を抽出する

`sources` 全体を横断して読む。Discord は `target` / `replyChain` / `siblings` / `thread`（開始メッセージ＋先頭メッセージ群）を時系列で、esa は `title` と `bodyMd` を読む。

**分割・返信対応**: 日付だけのメッセージと詳細が別メッセージに分かれている、返信で条件が上書きされている、といったケースを想定し、複数メッセージの情報を 1 つの予定にまとめる。1 つの文脈に複数の予定が含まれる場合は複数作成する。

各予定について次を決める:

| 項目 | 説明 |
| --- | --- |
| `summary` | 予定タイトル（簡潔に） |
| `start` | 開始日時。時刻ありは ISO8601 でタイムゾーンオフセット付き（例 `2026-09-01T19:00:00+09:00`）。終日は `YYYY-MM-DD` |
| `end` | 終了日時（同形式）。不明なら省略（時刻ありは +1時間、終日は翌日になる） |
| `allDay` | 終日なら `true` |
| `location` | 場所（オンラインなら URL や「Zoom」等） |
| `description` | 補足。**末尾に必ず出典を書く**: `Source: <URL>（著者/チャンネル名 または esa カテゴリ）`。ソースが複数ならすべて列挙 |
| `recurrence` | 繰り返しがあれば RRULE 配列（例 `["RRULE:FREQ=WEEKLY;BYDAY=TU"]`） |

**日付の解釈**: 「明日」「来週火曜」などの相対表現は、今日の日付とタイムゾーン `Asia/Tokyo` を基準に絶対日時へ変換する。年が無ければ直近の未来の日付とみなす。

**曖昧なときは推測しない**: 日付や開始時刻が特定できない、Discord と esa で日時・場所が食い違う、といった場合はユーザーに確認する。

### 4. ユーザーに確認する

抽出した予定を箇条書き（タイトル / 日時 / 場所 / 出典）で提示し、「この内容で作成してよいか」を一度だけ確認する。カレンダーへの書き込みは副作用なので、承認を得てから次へ進む。

### 5. 重複チェック → 作成

各予定について:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/find-duplicate.mjs" --summary "<summary>" --start "<start ISO>"
```

- 出力の `candidates[]` を意味的に確認する。`likelyMatch:true` は機械的なヒントに過ぎないので、タイトル・日時・場所から見て**同じ予定**だと判断できる候補があるかを自分で決める。
- **同一と判断した場合**: その予定は作成せず、次を返す。
  > ✅ この予定は作成済みです: <candidate.summary>（<日時>）
  > <candidate.htmlLink>
- **無い場合**: 予定 JSON を作って作成する。

```bash
echo '{"summary":"...","start":"2026-09-01T19:00:00+09:00","end":"2026-09-01T20:00:00+09:00","location":"...","description":"...\n\nSource: <url>（...）"}' \
  | node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/create-event.mjs"
```

  作成先は既定で `GOOGLE_CALENDAR_ID`（未設定なら primary）。ユーザーが「〜のカレンダーに」と
  指定した場合のみ `--calendar "<id>"` を付ける（`find-duplicate.mjs` にも同じ `--calendar` を渡す）。
  どのカレンダーがあるか不明なときは `node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/list-calendars.mjs"` で確認。

  成功したら:
  > 📅 予定を追加しました: <summary>（<日時>）
  > <event.htmlLink>

### 6. まとめて報告する

すべての予定について「新規作成」か「作成済み」かと、そのカレンダーリンクを日本語でまとめて報告する。取得時の `warnings` があれば併記する。

## 注意

- `.env` が未設定だとスクリプトがエラーを返す。その場合は `node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/check-setup.mjs"` の実行と README のセットアップ手順を案内する。
- 予定の削除・変更はこのスキルでは行わない（作成と重複チェックのみ）。
