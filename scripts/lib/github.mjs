// GitHub の検索。依存ゼロ。
//
// Issue/PR・コード・コミット・リポジトリは REST の Search API (/search/*) を使い、
// Discussions だけは REST search に無いので GraphQL (POST /graphql) を使う。
// どちらも lib/search.mjs の共通ヒット形に正規化して返す。
import { config } from "./config.mjs";
import { excerpt, tokenize, groupTerms } from "./text.mjs";
import { groupsToQuery } from "./expand.mjs";

const API = "https://api.github.com";
const DEFAULT_KINDS = ["issues", "code"];
const SUPPORTED_KINDS = new Set(["issues", "code", "commits", "repos", "discussions"]);

// code ヒットの author / timestamp 補完は 1 ヒットにつき 1 リクエスト増える。
// Search API は認証済みでも 30 req/min なので、補完する件数に上限を設ける。
const CODE_ENRICH_LIMIT = 10;

async function ghFetch(path, opts = {}) {
  const token = config.githubToken;
  if (!token) throw new Error("GITHUB_TOKEN が未設定です");

  const { params, accept, headers, ...fetchOpts } = opts;
  const query = params ? `?${new URLSearchParams(params)}` : "";
  const res = await fetch(`${API}${path}${query}`, {
    ...fetchOpts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept
        ? `${accept}, application/vnd.github+json`
        : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lab-assistant",
      ...headers,
    },
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = json.message || `HTTP ${res.status}`;
    if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
      const resetHeader = res.headers.get("x-ratelimit-reset");
      const reset = Number(resetHeader);
      const resetAt = resetHeader && Number.isFinite(reset)
        ? new Date(reset * 1000).toLocaleString("ja-JP")
        : "不明";
      throw new Error(`GitHub API のレート制限に達しました（リセット予定: ${resetAt}）`);
    }
    if (res.status === 401) {
      throw new Error("GitHub API の認証に失敗しました。GITHUB_TOKEN が無効か失効しています");
    }
    if (res.status === 422) {
      throw new Error(`GitHub の検索クエリ構文が不正です: ${message}`);
    }
    throw new Error(`GitHub API ${res.status}: ${message}`);
  }
  return json;
}

/** ISO8601 / YYYY-MM-DD を GitHub 検索修飾子用の日付にする。 */
function ymd(value) {
  return String(value).slice(0, 10);
}

/** org は個別リクエスト、repo は同一クエリ内の OR 条件として扱う。 */
function makeScopes(orgs, repos) {
  const repoQualifiers = [...new Set(repos || [])].map((repo) => `repo:${repo}`);
  const uniqueOrgs = [...new Set(orgs || [])];
  if (uniqueOrgs.length) {
    return uniqueOrgs.map((org) => [`org:${org}`, ...repoQualifiers]);
  }
  if (repoQualifiers.length) return [repoQualifiers];
  return [[]];
}

function makeQuery(query, scope, dateQualifiers = []) {
  return [query, ...scope, ...dateQualifiers].filter(Boolean).join(" ");
}

function repoFromApiUrl(url) {
  const match = String(url || "").match(/\/repos\/([^/]+\/[^/]+)$/);
  return match ? match[1] : null;
}

/** extra では取得できなかった値を省略する。false / 0 は残す。 */
function compact(values) {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== null && value !== undefined)
  );
}

function issueHit(item, terms) {
  const isPullRequest = !!item.pull_request;
  return {
    source: "github",
    title: item.title || "(無題)",
    url: item.html_url || null,
    snippet: excerpt(item.body || "", terms),
    author: item.user?.login || null,
    timestamp: item.created_at || null,
    extra: compact({
      kind: isPullRequest ? "pull_request" : "issue",
      repo: repoFromApiUrl(item.repository_url),
      state: item.state || null,
      labels: item.labels?.length
        ? item.labels.map((label) => label.name).filter(Boolean)
        : null,
      number: item.number ?? null,
    }),
  };
}

function codeHit(item, terms) {
  const fragment = (item.text_matches || [])
    .map((match) => match.fragment)
    .filter(Boolean)
    .join(" ");
  return {
    source: "github",
    title: item.path || item.name || "(パス不明)",
    url: item.html_url || null,
    snippet: excerpt(fragment, terms),
    author: null,
    timestamp: null,
    extra: compact({
      kind: "code",
      repo: item.repository?.full_name || null,
      path: item.path || null,
    }),
  };
}

function commitHit(item, terms) {
  const message = item.commit?.message || "";
  return {
    source: "github",
    title: message.split(/\r?\n/, 1)[0] || item.sha || "(メッセージなし)",
    url: item.html_url || null,
    snippet: excerpt(message, terms),
    author: item.author?.login || item.committer?.login || null,
    timestamp: item.commit?.author?.date || item.commit?.committer?.date || null,
    extra: compact({
      kind: "commit",
      repo: item.repository?.full_name || null,
      sha: item.sha || null,
    }),
  };
}

function repoHit(item, terms) {
  return {
    source: "github",
    title: item.full_name || item.name || "(リポジトリ名不明)",
    url: item.html_url || null,
    snippet: excerpt(item.description || "", terms),
    author: item.owner?.login || null,
    timestamp: item.created_at || null,
    extra: compact({
      kind: "repo",
      repo: item.full_name || null,
      language: item.language || null,
      stars: item.stargazers_count ?? null,
      visibility: item.visibility || (item.private ? "private" : "public"),
      archived: !!item.archived,
    }),
  };
}

/** GitHub GraphQL API を叩く。REST と違い HTTP 200 でも errors が返ることがある。 */
async function ghGraphQL(query, variables) {
  const token = config.githubToken;
  if (!token) throw new Error("GITHUB_TOKEN が未設定です");

  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lab-assistant",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("GitHub API の認証に失敗しました。GITHUB_TOKEN が無効か失効しています");
    }
    throw new Error(`GitHub GraphQL ${res.status}: ${json.message || "不明なエラー"}`);
  }
  if (json.errors?.length) {
    const types = json.errors.map((e) => e.type || "").join(",");
    const message = json.errors.map((e) => e.message).filter(Boolean).join(" / ");
    if (/INSUFFICIENT_SCOPES/i.test(types) || /scope/i.test(message)) {
      throw new Error(
        "トークンに Discussions の読み取り権限がありません。" +
          "PAT のスコープ (classic なら repo / public_repo、fine-grained なら Discussions の Read) を確認してください"
      );
    }
    if (/RATE_LIMITED/i.test(types)) {
      throw new Error(
        "GitHub GraphQL API のレート制限に達しました (GraphQL は REST とは別枠のポイント制です)"
      );
    }
    throw new Error(`GitHub GraphQL: ${message || "不明なエラー"}`);
  }
  return json.data || {};
}

const DISCUSSION_SEARCH = `
query($q: String!, $n: Int!) {
  search(type: DISCUSSION, query: $q, first: $n) {
    discussionCount
    nodes {
      ... on Discussion {
        title
        url
        bodyText
        createdAt
        author { login }
        category { name }
        repository { nameWithOwner }
        answerChosenAt
        comments { totalCount }
      }
    }
  }
}`;

function discussionHit(node, terms) {
  return {
    source: "github",
    title: node.title || "(無題)",
    url: node.url || null,
    snippet: excerpt(node.bodyText || "", terms),
    // author はアカウント削除などで null になりうる
    author: node.author?.login || null,
    timestamp: node.createdAt || null,
    extra: compact({
      kind: "discussion",
      repo: node.repository?.nameWithOwner || null,
      category: node.category?.name || null,
      answered: node.answerChosenAt ? true : false,
      comments: node.comments?.totalCount ?? null,
    }),
  };
}

/** Discussions を GraphQL で検索する (REST の SEARCHES とは別経路)。 */
async function searchDiscussions({ query, scope, since, until, limit, terms }) {
  const dates = [
    since ? `created:>=${ymd(since)}` : null,
    until ? `created:<=${ymd(until)}` : null,
  ];
  const q = makeQuery(query, scope, dates);
  const data = await ghGraphQL(DISCUSSION_SEARCH, { q, n: limit });
  const search = data.search || {};
  return {
    total: search.discussionCount ?? 0,
    // union 型なので Discussion 以外が混ざると空オブジェクトになる。title の有無で弾く。
    hits: (search.nodes || []).filter((n) => n && n.url).map((n) => discussionHit(n, terms)),
  };
}

/**
 * code ヒットに author / timestamp を補う。
 * code 検索の結果にはそれらが含まれないので、そのファイルの最新コミットを 1 件引く。
 * 失敗しても検索全体は落とさず、そのヒットを null のままにする。
 */
async function enrichCodeHits(hits, warnings) {
  const targets = hits.filter((h) => h.extra?.kind === "code").slice(0, CODE_ENRICH_LIMIT);
  if (!targets.length) return;

  const cache = new Map(); // "repo\0path" → { author, timestamp } | null
  let failed = 0;

  await Promise.all(
    targets.map(async (hit) => {
      const repo = hit.extra?.repo;
      const path = hit.extra?.path;
      if (!repo || !path) return;
      const key = `${repo}\0${path}`;

      if (!cache.has(key)) {
        cache.set(
          key,
          ghFetch(`/repos/${repo}/commits`, { params: { path, per_page: "1" } })
            .then((commits) => {
              const c = Array.isArray(commits) ? commits[0] : null;
              if (!c) return null;
              return {
                author: c.author?.login || c.commit?.author?.name || null,
                timestamp: c.commit?.author?.date || c.commit?.committer?.date || null,
              };
            })
            .catch(() => {
              failed++;
              return null;
            })
        );
      }

      const info = await cache.get(key);
      if (info) {
        hit.author = info.author;
        hit.timestamp = info.timestamp;
      }
    })
  );

  if (failed) {
    warnings.push(`code ヒット ${failed} 件は最新コミットを引けず author / timestamp が空のままです`);
  }
}

const SEARCHES = {
  issues: {
    path: "/search/issues",
    dates(since, until) {
      return [
        since ? `created:>=${ymd(since)}` : null,
        until ? `created:<=${ymd(until)}` : null,
      ];
    },
    toHit: issueHit,
  },
  code: {
    path: "/search/code",
    accept: "application/vnd.github.text-match+json",
    dates() {
      return [];
    },
    toHit: codeHit,
  },
  commits: {
    path: "/search/commits",
    dates(since, until) {
      return [
        since ? `committer-date:>=${ymd(since)}` : null,
        until ? `committer-date:<=${ymd(until)}` : null,
      ];
    },
    toHit: commitHit,
  },
  repos: {
    path: "/search/repositories",
    dates(since, until) {
      return [
        since ? `created:>=${ymd(since)}` : null,
        until ? `created:<=${ymd(until)}` : null,
      ];
    },
    toHit: repoHit,
  },
};

/**
 * GitHub の Issue / PR・コード・コミット・リポジトリ・Discussions を検索する。
 * @param {{query:string, since?:string, until?:string, limit?:number,
 *          orgs?:string[], repos?:string[], kinds?:string[], enrichCode?:boolean}} opts
 *   kinds は "issues" | "code" | "commits" | "repos" | "discussions" (既定 ["issues","code"])。
 *   discussions だけ GraphQL 経由。
 *   enrichCode を付けると code ヒットの author / timestamp を補うが、
 *   **1 ヒットにつき 1 リクエスト増える** (先頭 CODE_ENRICH_LIMIT 件のみ)。
 * @returns {Promise<{hits:object[], warnings:string[], total:number}>}
 */
export async function searchGitHub(opts = {}) {
  const { since, until, orgs = [], repos = [] } = opts;
  // 関連語グループがあれば GitHub の OR 検索に落とす
  const groups = opts.groups?.length ? opts.groups : null;
  const query = groups ? groupsToQuery(groups, { or: "OR", maxVariants: 5 }) : opts.query;
  const terms = groups ? groupTerms(groups) : tokenize(opts.query);
  if (terms.length === 0) throw new Error("検索キーワードが空です");

  const warnings = [];
  const requestedKinds = [
    ...new Set(opts.kinds?.length ? opts.kinds : DEFAULT_KINDS),
  ];
  const kinds = [];
  for (const kind of requestedKinds) {
    if (!SUPPORTED_KINDS.has(kind)) {
      warnings.push(`未対応の GitHub 検索種別です: ${kind}`);
    } else {
      kinds.push(kind);
    }
  }
  if (kinds.includes("code") && (since || until)) {
    warnings.push("code 検索は期間指定に非対応のため、since / until を無視します");
  }
  if (!orgs.length && !repos.length) {
    warnings.push("GitHub の検索対象が絞られていません。GitHub 全体を検索します");
  }

  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 100);
  const scopes = makeScopes(orgs, repos);
  const runs = [];
  for (const kind of kinds) {
    if (kind === "discussions") {
      // REST search に Discussions は無いので GraphQL 経路に回す
      for (const scope of scopes) {
        runs.push(searchDiscussions({ query, scope, since, until, limit, terms }));
      }
      continue;
    }
    const search = SEARCHES[kind];
    for (const scope of scopes) {
      runs.push(
        ghFetch(search.path, {
          params: {
            q: makeQuery(query, scope, search.dates(since, until)),
            per_page: String(limit),
          },
          accept: search.accept,
        }).then((json) => ({
          total: json.total_count ?? 0,
          hits: (json.items || []).map((item) => search.toHit(item, terms)),
        }))
      );
    }
  }

  const results = await Promise.all(runs);
  const total = results.reduce((sum, result) => sum + result.total, 0);
  const seen = new Set();
  const hits = [];
  // 1 種類の結果だけで limit を使い切らないよう、種類・scope ごとに交互に採る。
  for (let index = 0; hits.length < limit; index++) {
    let hasCandidate = false;
    for (const result of results) {
      const hit = result.hits[index];
      if (!hit) continue;
      hasCandidate = true;
      const key = hit.url || `${hit.extra?.kind}:${hit.title}:${hit.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    if (!hasCandidate) break;
  }

  if (opts.enrichCode) await enrichCodeHits(hits, warnings);

  return { hits, warnings, total };
}
