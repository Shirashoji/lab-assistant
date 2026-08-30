// GitHub REST API v3 の薄いラッパと検索。依存ゼロ。
import { config } from "./config.mjs";
import { excerpt, tokenize } from "./text.mjs";

const API = "https://api.github.com";
const DEFAULT_KINDS = ["issues", "code"];
const SUPPORTED_KINDS = new Set(["issues", "code", "commits", "repos"]);

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
 * GitHub の Issue / PR・コード・コミット・リポジトリを検索する。
 * @param {{query:string, since?:string, until?:string, limit?:number,
 *          orgs?:string[], repos?:string[], kinds?:string[]}} opts
 * @returns {Promise<{hits:object[], warnings:string[], total:number}>}
 */
export async function searchGitHub(opts = {}) {
  const { query, since, until, orgs = [], repos = [] } = opts;
  const terms = tokenize(query);
  if (terms.length === 0) throw new Error("検索キーワードが空です");

  const warnings = [];
  const requestedKinds = [
    ...new Set(opts.kinds?.length ? opts.kinds : DEFAULT_KINDS),
  ];
  const kinds = [];
  for (const kind of requestedKinds) {
    if (kind === "discussions") {
      warnings.push("discussions 検索は未対応です（GitHub GraphQL API が必要なためスキップ）");
    } else if (!SUPPORTED_KINDS.has(kind)) {
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

  return { hits, warnings, total };
}
