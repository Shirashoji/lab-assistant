#!/usr/bin/env node
// GITHUB_TOKEN が「横断検索のどの機能まで使えるか」を実際に叩いて確かめる。
//
//   node scripts/bin/check-github-token.mjs
//   node scripts/bin/check-github-token.mjs --org vdslab   # 対象 org を上書き
//   node scripts/bin/check-github-token.mjs --json
//
// PAT の種類 (classic / fine-grained) や必要スコープは docs/GITHUB-TOKEN.md 参照。
// check-setup.mjs は疎通だけを見るが、こちらは機能ごとに 1 回ずつ実際に検索する。
import { config } from "../lib/config.mjs";

const API = "https://api.github.com";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") out.json = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "true";
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const token = config.githubToken;
if (!token) {
  process.stderr.write(
    "GITHUB_TOKEN が未設定です。docs/GITHUB-TOKEN.md の手順で発行して .env に入れてください。\n"
  );
  process.exit(2);
}

/** トークンの見た目から種類を判定する (発行元でプレフィックスが決まっている)。 */
function tokenKind(t) {
  if (t.startsWith("github_pat_")) return "fine-grained PAT";
  if (t.startsWith("ghp_")) return "classic PAT";
  if (t.startsWith("gho_")) return "OAuth トークン (gh CLI など)";
  if (t.startsWith("ghs_")) return "GitHub App のインストールトークン";
  return "不明な形式";
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lab-assistant",
};

async function get(path, params) {
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const res = await fetch(`${API}${path}${qs}`, { headers });
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

const results = [];
/** ok: true=通った / false=通らなかった / null=判定できなかった (合否には数えない) */
function record(name, ok, detail, hint) {
  results.push({ name, ok, detail, hint });
}

/** REST の検索エンドポイントを 1 件だけ叩いて可否を見る。 */
async function probeSearch(name, path, q, accept) {
  try {
    const res = await fetch(`${API}${path}?${new URLSearchParams({ q, per_page: "1" })}`, {
      headers: accept ? { ...headers, Accept: `${accept}, application/vnd.github+json` } : headers,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok) {
      return record(name, true, `${json.total_count ?? 0} 件ヒット`);
    }
    const msg = json.message || `HTTP ${res.status}`;
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      return record(name, false, "レート制限中 (判定不能)", "少し待ってから再実行してください");
    }
    if (res.status === 422) {
      // 存在しない org / repo を指定したときもここに来る (権限の問題とは限らない)
      return record(
        name,
        false,
        `クエリ拒否: ${msg}`,
        "指定した org / repo が存在しないか、このトークンからは見えていません。" +
          "GITHUB_ORGS / GITHUB_REPOS の綴りを確認してください"
      );
    }
    if (res.status === 403 || res.status === 404) {
      return record(name, false, msg, "トークンの種類か権限が足りません (docs/GITHUB-TOKEN.md)");
    }
    record(name, false, msg);
  } catch (e) {
    record(name, false, e.message);
  }
}

async function probeDiscussions(scope) {
  const query = `query($q: String!) { search(type: DISCUSSION, query: $q, first: 1) { discussionCount } }`;
  try {
    const res = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { q: `test ${scope}`.trim() } }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      return record("Discussions 検索 (GraphQL)", false, json.message || `HTTP ${res.status}`);
    }
    if (json.errors?.length) {
      const message = json.errors.map((e) => e.message).join(" / ");
      const types = json.errors.map((e) => e.type || "").join(",");
      return record(
        "Discussions 検索 (GraphQL)",
        false,
        message,
        /INSUFFICIENT_SCOPES|scope/i.test(`${types} ${message}`)
          ? "classic なら repo (private) / public_repo (public)、fine-grained なら Discussions: Read"
          : undefined
      );
    }
    record(
      "Discussions 検索 (GraphQL)",
      true,
      `${json.data?.search?.discussionCount ?? 0} 件ヒット` +
        (json.data?.search?.discussionCount === 0
          ? " (この org が Discussions を使っていないだけの可能性あり)"
          : "")
    );
  } catch (e) {
    record("Discussions 検索 (GraphQL)", false, e.message);
  }
}

/**
 * 著者補完の判定に使うリポジトリを 1 つ選ぶ。
 * GITHUB_REPOS が無ければ対象 org の更新が新しいリポジトリを 1 件借りる。
 */
async function pickProbeRepo(repos, orgs) {
  if (repos.length) return repos[0];
  if (!orgs.length) return null;
  const { res, json } = await get(`/orgs/${orgs[0]}/repos`, {
    per_page: "1",
    sort: "updated",
  });
  if (!res.ok || !Array.isArray(json) || !json[0]) return null;
  return json[0].full_name || null;
}

/** code ヒットの著者補完 (--enrich-code) が使えるか。 */
async function probeCommits(repo) {
  if (!repo) {
    return record(
      "code 著者補完 (List commits)",
      null,
      "判定に使えるリポジトリが見つかりませんでした",
      "GITHUB_REPOS に owner/name を 1 つ入れると判定できます"
    );
  }
  const { res, json } = await get(`/repos/${repo}/commits`, { per_page: "1" });
  if (res.ok) {
    return record("code 著者補完 (List commits)", true, `${repo} の最新コミットを取得できました`);
  }
  record(
    "code 著者補完 (List commits)",
    false,
    json.message || `HTTP ${res.status}`,
    "classic なら repo、fine-grained なら Contents: Read が必要です"
  );
}

async function main() {
  const orgs = args.org ? [args.org] : config.githubOrgs;
  const repos = config.githubRepos;
  // 検索エンドポイントごとに使える修飾子が違う。
  //   issues / commits / code … repo: と org: の両方が使える
  //   repositories            … repo: は使えない。org: か user: を使う
  const scope = repos.length ? `repo:${repos[0]}` : orgs.length ? `org:${orgs[0]}` : "";
  const repoScope = orgs.length
    ? `org:${orgs[0]}`
    : repos.length
    ? `user:${repos[0].split("/")[0]}`
    : "";

  // ── トークン本体 ────────────────────────────────────────
  const { res: userRes, json: user } = await get("/user");
  const kind = tokenKind(token);
  if (!userRes.ok) {
    record("トークン", false, user.message || `HTTP ${userRes.status}`, "トークンが無効か失効しています");
  } else {
    // classic / OAuth トークンだけがスコープをヘッダで返す
    const scopes = userRes.headers.get("x-oauth-scopes");
    record(
      "トークン",
      true,
      `${kind} / User: ${user.login}` +
        (scopes ? ` / スコープ: ${scopes}` : " / スコープ: (fine-grained のためヘッダには出ません)")
    );
  }

  // ── レート制限 ──────────────────────────────────────────
  const { json: rate } = await get("/rate_limit");
  const r = rate.resources || {};
  record(
    "レート制限",
    true,
    `search ${r.search?.limit ?? "?"}/分 ・ code_search ${r.code_search?.limit ?? "?"}/分 ・ ` +
      `graphql ${r.graphql?.limit ?? "?"}/時 ・ core ${r.core?.limit ?? "?"}/時`
  );

  // ── 機能ごとの可否 ──────────────────────────────────────
  const q = (base) => [base, scope].filter(Boolean).join(" ");
  await probeSearch("Issue / PR 検索", "/search/issues", q("test"));
  await probeSearch(
    "コード検索",
    "/search/code",
    q("test"),
    "application/vnd.github.text-match+json"
  );
  await probeSearch("コミット検索", "/search/commits", q("test"));
  await probeSearch(
    "リポジトリ検索",
    "/search/repositories",
    ["test", repoScope].filter(Boolean).join(" ")
  );
  await probeDiscussions(scope);
  await probeCommits(await pickProbeRepo(repos, orgs));

  if (args.json) {
    process.stdout.write(JSON.stringify({ tokenKind: kind, scope, results }, null, 2) + "\n");
    return;
  }

  process.stdout.write(`GITHUB_TOKEN の機能確認${scope ? ` (対象: ${scope})` : " (対象指定なし)"}\n\n`);
  for (const x of results) {
    const mark = x.ok === true ? "✅" : x.ok === false ? "❌" : "—";
    process.stdout.write(`  ${mark} ${x.name}${x.detail ? ` — ${x.detail}` : ""}\n`);
    if (x.ok !== true && x.hint) process.stdout.write(`      → ${x.hint}\n`);
  }
  if (!scope) {
    process.stdout.write(
      "\n※ GITHUB_ORGS / GITHUB_REPOS が未設定のため GitHub 全体を対象に判定しました。\n" +
        "  private リポジトリまで見えるかはこの結果では分かりません。\n"
    );
  }
  process.stdout.write("\n詳しい権限の説明: docs/GITHUB-TOKEN.md\n");

  // 判定できなかったもの (null) は失敗に数えない
  const failed = results.filter((x) => x.ok === false);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
