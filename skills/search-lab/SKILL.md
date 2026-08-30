---
name: search-lab
description: >-
  研究室・学科の情報を横断的に調べたいとき全般の入口。あるトピックについて esa / Slack / Discord /
  ゼミ Google Calendar を横断検索し、出典付きで要約する。日程を知りたいだけなら find-schedule、
  共有済みか確認したいだけなら check-shared を使う。
argument-hint: "<調べたいこと>"
---

# 研究室・学科の情報を横断検索する

`$ARGUMENTS` のトピックを `scripts/bin/search.mjs` で横断検索し、結果を 1 つにまとめて
出典付きで答える。esa / Calendar / Slack / Discord / GitHub / Drive はすべてこの 1 コマンドで
検索でき、**esa MCP が使えるかどうかに関係なく動く**。

## まず振り分け

- **「いつ?」「日程」「何時から」** が主目的 → `find-schedule` スキルへ。
- **「もう共有された?」「既出?」** が主目的 → `check-shared` スキルへ。
- **「どのチャンネル?」** → `find-channel` スキルへ。
- **「誰が詳しい?」「誰に聞けばいい?」** が主目的 → `find-expert` スキルへ。
- それ以外の「〜について知りたい / 経緯を追いたい」→ このまま続行。

## 手順

### 1. 検索語を組み立てる

期間は既定で **今日の 180 日前**〜今日。古い経緯も追うなら広げる。以降 `<SINCE>` はその日付。

検索語は 1〜2 個でよい。**関連語はスクリプト側が自動で広げる**(「ゼミ」→ セミナー / seminar /
研究会、「可視化」→ ビジュアライゼーション / visualization / viz。グループ内 OR / グループ間 AND)。
辞書に無い言い換え(研究テーマ名・人名・プロジェクト名など)を足したいときだけ
`--related 語1,語2` を使う。逆に絞り込みすぎるほど広がってしまうときは `--no-expand`。

### 2. 横断検索する

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/search.mjs" "<検索語>" --since <SINCE> --limit 40 --text
```

(既定ソース = 設定済みの全ソース `esa,calendar,slack,discord,github,drive`。`--source` で絞ってもよい。
GitHub は `--kinds issues,code` で種別を選べる。)
`hits[]` の permalink・チャンネル・投稿者・日付・抜粋を控える。`skipped` / `warnings` を確認する。
出力の `関連語も検索:` 行に、実際に何へ展開されたかが出る。

ヒットが少なすぎるときは `--related` で言い換えを足す、期間を広げる、検索語を短くする。
多すぎるときは `--no-expand` か、語を足して AND を強める。

esa 記事の本文をもっと読みたいときは、記事 URL を
`node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/collect-context.mjs" "<esa URL>"` に渡すと全文が取れる。
(esa MCP が使えるセッションなら `esa_search_posts` を併用してもよいが、必須ではない。)

### 3.5 Drive の資料を深く読む(必要なときだけ)

Drive のヒットがタイトルと更新日しか分からず、それでは答えられないときだけ、ファイルを落として読む。
Google ドキュメントはテキスト、スライドは PDF に変換されるので、どちらも Read でそのまま読める。

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bin/drive-fetch.mjs" "<Drive の URL か fileId>" --text
```

出力の `保存先:` のパスを Read で読む。テキスト系なら `--print` で標準出力に直接出せる。
出力の最後の行が「Read では読めません」と言っていたら従うこと(`.pptx` などの Office 形式は
バイト列のままなので Read では開けない。その場合は Drive の Web リンクを案内する)。
**落とすのは本当に必要な数件だけ**にする(全ヒットを落とさない)。
このスクリプトは読み取り専用で、Drive 側を変更することはない。

### 4. まとめて答える

- **時系列**または**論点別**に整理する。誰がいつ何を言ったか、決まったこと / 未決のことを分ける。
- すべての主張に **出典(URL / permalink)** を付ける。
- **見たソースと期間・カバレッジ**を必ず明記する(スキップ・権限不足も)。
- 最後に「次に見るべき記事 / スレッド」を 1〜2 個挙げる。
  人を特定したくなったら `find-expert` スキルに引き継ぐ。

## 注意

- 投稿・書き込み・カレンダー変更などの副作用操作はこのスキルではしない(調査のみ)。
- 情報が薄いときは「この範囲では確かなことは言えない」と正直に書く。
