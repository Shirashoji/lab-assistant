# GitHub トークン(`GITHUB_TOKEN`)の権限

lab-assistant の GitHub 横断検索に必要な Personal Access Token(PAT)の種類・権限・
発行手順をまとめる。**設定しなくても他のソース(Calendar / Slack / Discord / esa / Drive)は
そのまま動く**。GitHub ソースがスキップされるだけ。

> 迷ったら **classic PAT + `repo` スコープ**。
> 理由は「[classic か fine-grained か](#classic-か-fine-grained-か)」参照。

## 何にトークンを使っているか

| 機能 | 叩いている API | 使う場面 |
| --- | --- | --- |
| Issue / PR 検索 | `GET /search/issues` | `search-lab` / `find-expert` / `check-shared` |
| コード検索 | `GET /search/code` | 実装・ライブラリの調査、`find-channel` |
| コミット検索 | `GET /search/commits` | 変更の経緯を追うとき |
| リポジトリ検索 | `GET /search/repositories` | `find-channel`(どのリポジトリの話か) |
| Discussions 検索 | `POST /graphql`(`search(type: DISCUSSION)`) | 議論スレッドの検索 |
| code ヒットの著者補完 | `GET /repos/{owner}/{repo}/commits` | `find-expert`(`--enrich-code`、既定 ON) |
| 疎通確認 | `GET /user` / `GET /rate_limit` | `check-setup.mjs` / `check-github-token.mjs` |

すべて **読み取りのみ**。lab-assistant は GitHub に書き込みを一切しない。

## classic か fine-grained か

**classic PAT を推奨する。** 理由:

- GitHub の公式ドキュメントは、**Search 系エンドポイントに必要な fine-grained の権限を
  明記していない**([Permissions required for fine-grained PATs][fg-perms] の表に
  search エンドポイントが載っていない)。
- コミュニティでは「fine-grained だと Issue 検索が通らないが、コード検索は通った」という
  報告がある([community #61130][community])。挙動が endpoint ごとにばらつく。
- org(例 `vdslab`)のリソースを fine-grained で読むには、**org 側で fine-grained PAT を
  許可する設定**と、多くの場合オーナーの承認が要る。classic PAT なら SSO 認可だけで済む。

fine-grained を使いたい場合は下に権限表を書いたが、**必ず
`node scripts/bin/check-github-token.mjs` で実際に通るか確かめること**。

## classic PAT に必要なスコープ

| スコープ | 要否 | 何のために |
| --- | --- | --- |
| `repo` | **private リポジトリを検索するなら必須** | private の Issue / PR / コード / コミット / Discussions の読み取り。`vdslab` の private リポジトリを見るならこれ |
| `public_repo` | public だけでよいなら代わりにこれ | public リポジトリの読み取り。Discussions も含む |
| `read:org` | 任意 | org のメンバー情報。**検索自体には不要** |

- 検証済み(2026-08-30): `repo` + `read:org` を持つトークンで、上の表の機能がすべて成功した。
  実際に試したのは gh CLI の OAuth トークン(`gho_`)だが、**classic PAT と同じスコープの仕組み**
  なので `ghp_` + `repo` でも同じ結果になる。
- リポジトリ Discussions の GraphQL は **private なら `repo`、public なら `public_repo`** が必要
  ([Using the GraphQL API for Discussions][gql-discussions])。
- `read:discussion` という別スコープもあるが、これは**チームの議論(team discussions)**用で、
  リポジトリの Discussions には関係ない。付けなくてよい。
- org が SAML SSO を使っている場合、発行後に **トークンを SSO 認可**する必要がある
  (トークン一覧の `Configure SSO` から対象 org を Authorize)。

## fine-grained PAT に必要な権限(参考・要検証)

**Resource owner** を対象 org(例 `vdslab`)にし、**Repository access** は
`All repositories` か、検索したいリポジトリを選ぶ。

| 権限 | レベル | 何のために |
| --- | --- | --- |
| Repository → **Metadata** | Read | 必須(他の権限を選ぶと自動で付く)。リポジトリの基本情報 |
| Repository → **Contents** | Read | コード検索、コミット検索、code ヒットの著者補完(`List commits`) |
| Repository → **Issues** | Read | Issue 検索 |
| Repository → **Pull requests** | Read | PR 検索(`/search/issues` は PR も返す) |
| Repository → **Discussions** | Read | Discussions 検索 |

> ⚠ 上の表は各エンドポイントの実体(Contents / Issues / …)から導いた**推定**で、
> GitHub が Search API について明示している権限ではない。
> 発行したら必ず `node scripts/bin/check-github-token.mjs` で確認すること。
> Issue 検索だけ落ちる場合は classic PAT に切り替えるのが早い。

## 発行手順(classic)

1. <https://github.com/settings/tokens> → **Generate new token (classic)**
2. **Note** に `lab-assistant` など分かる名前を付ける
3. **Expiration** を決める(無期限は避ける。切れたら再発行して `.env` を差し替える)
4. **Select scopes** で `repo` にチェック(public だけでよければ `public_repo`)
5. **Generate token** → 表示された `ghp_...` をコピー(**この画面を離れると二度と見られない**)
6. org が SAML SSO を使っているなら、トークン一覧の `Configure SSO` から対象 org を **Authorize**

## `.env` に設定する

```bash
# ── GitHub ───────────────────────────────────────────────────
# 発行手順と必要な権限: docs/GITHUB-TOKEN.md
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
# 検索対象の org (カンマ区切り)。未設定だと GitHub 全体が対象になり実用的でない
GITHUB_ORGS=vdslab
# さらに絞る場合のリポジトリ (owner/name のカンマ区切り、任意)
GITHUB_REPOS=
```

**`GITHUB_ORGS` は実質必須**。未設定だと GitHub 全体を検索してしまい、
研究室と無関係なヒットで埋まる。

## 設定できたか確認する

```bash
node scripts/bin/check-github-token.mjs
```

機能ごとに 1 回ずつ実際に検索して、通るものと通らないものを出す。

実際の出力(`repo` + `read:org` のトークン / 対象 `vdslab`):

```
GITHUB_TOKEN の機能確認 (対象: org:vdslab)

  ✅ トークン — OAuth トークン (gh CLI など) / User: Shirashoji / スコープ: gist, read:org, repo, workflow
  ✅ レート制限 — search 30/分 ・ code_search 10/分 ・ graphql 5000/時 ・ core 5000/時
  ✅ Issue / PR 検索 — 144 件ヒット
  ✅ コード検索 — 11 件ヒット
  ✅ コミット検索 — 284 件ヒット
  ✅ リポジトリ検索 — 0 件ヒット
  ✅ Discussions 検索 (GraphQL) — 0 件ヒット (この org が Discussions を使っていないだけの可能性あり)
  ✅ code 著者補完 (List commits) — vdslab/LLMGraphvis の最新コミットを取得できました
```

- 各行の `件ヒット` は「`test` という語で 1 件だけ試しに検索した結果の総数」で、
  **通ったかどうかの目安**。0 件でも ✅ なら API 自体は使える。
- `—`(グレー)は「判定できなかった」。合否には数えない。
- `GITHUB_REPOS` が未設定なら、著者補完の判定用に対象 org の更新が新しいリポジトリを 1 件借りる。

`node scripts/bin/check-setup.mjs` でも `GET /user` の疎通と残りレート制限は見えるが、
**機能ごとの可否まで見たいときはこちらを使う**。

## レート制限

`GET /rate_limit` の実測値(認証済み・2026-08-30)。

| 区分 | 上限 | 使うところ |
| --- | --- | --- |
| `search` | **30 リクエスト/分** | Issue / PR・コミット・リポジトリ検索 |
| `code_search` | **10 リクエスト/分** | コード検索(`--kinds code`)。**別枠かつ厳しい** |
| `graphql` | 5000 ポイント/時 | Discussions 検索 |
| `core` | 5000 リクエスト/時 | code ヒットの著者補完(`List commits`) |

刺さりやすいのはコード検索。lab-assistant は **org ごと・検索種別ごとに 1 リクエスト**出すので、
`GITHUB_ORGS` に org を 3 つ入れて `--kinds issues,code,commits,repos` を指定すると
1 回の検索で 12 リクエストになる。実運用では:

- `--kinds` を絞る(既定は `issues,code` の 2 種類)
- `find-expert` の著者補完は先頭 10 件までに制限済み(`--no-enrich-code` で止められる)

## 既知の制約

- **コード検索は期間指定ができない**。`--since` / `--until` は無視され、警告が出る
  (GitHub 側の仕様)。
- **コード検索は既定ブランチのみ・インデックス済みのリポジトリのみ**が対象。
- **コード検索のヒットには著者と日付が含まれない**。`--enrich-code`(`find-expert` は既定 ON)
  で最新コミットから補完するが、**先頭 10 件まで**。
- **Discussions は org が実際に Discussions を使っていないと 0 件**になる。
  権限の問題と区別しにくいので、`check-github-token.mjs` はその旨を添えて表示する。
- lab-assistant は **読み取り専用**。Issue の作成やコメントはしない。

## トラブルシューティング

| 症状 | 原因と対処 |
| --- | --- |
| `github` が `skipped` に入る | `GITHUB_TOKEN` が未設定。`.env` を確認 |
| `GitHub API の認証に失敗しました` (401) | トークンが失効/無効。再発行して差し替える |
| `クエリ拒否: Validation Failed` (422) | `GITHUB_ORGS` / `GITHUB_REPOS` の綴り違い、またはそのトークンから見えない。`check-github-token.mjs` で切り分け |
| Issue 検索だけ落ちる | fine-grained PAT の可能性。classic PAT + `repo` に切り替える |
| private リポジトリが出てこない | classic なら `repo` スコープ、SAML SSO なら SSO 認可が要る |
| `レート制限に達しました` | コード検索は 10/分。`--kinds` を絞るか少し待つ |
| `トークンに Discussions の読み取り権限がありません` | classic は `repo` / `public_repo`、fine-grained は Discussions: Read |
| Discussions が常に 0 件 | その org が Discussions 機能を使っていない可能性。GitHub 上で確認 |

## セキュリティ

- `.env` は `.gitignore` 済み。**トークンをコミットしない**。
- 有効期限を付け、切れたら再発行する。
- 必要最小限のスコープにする(書き込み系スコープは不要)。
- 漏れたと思ったら <https://github.com/settings/tokens> から即 **Delete**。

[fg-perms]: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
[community]: https://github.com/orgs/community/discussions/61130
[gql-discussions]: https://docs.github.com/en/graphql/guides/using-the-graphql-api-for-discussions
