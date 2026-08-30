// esa API v1 の薄いラッパ。依存ゼロ。
//
// 提供するもの:
//   - getPost  … URL → 記事 1 件の取得 (add-event フロー)
//   - getUser  … 疎通確認
//   - searchPosts … 記事の全文検索 (横断検索の esa ソース)
//
// 検索は **公式 MCP (@esaio/esa-mcp-server) が使えない環境でも動く** ように
// ここで API を直接叩く。MCP が使えるセッションではどちらを使ってもよいが、
// scripts/bin/search.mjs は常にこちらを使うので esa だけ検索できない、
// という状態にはならない。
import { config } from "./config.mjs";
import { excerpt } from "./text.mjs";
import { groupsToQuery } from "./expand.mjs";

const API = "https://api.esa.io/v1";

async function apiGet(path, { retry = 1, params } = {}) {
  const token = config.esaToken;
  if (!token) throw new Error("ESA_ACCESS_TOKEN が未設定です");
  const qs = params ? `?${new URLSearchParams(params)}` : "";
  const res = await fetch(`${API}${path}${qs}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "lab-assistant/0.2.0",
    },
  });
  if ((res.status === 429 || res.status >= 500) && retry > 0) {
    const wait = Number(res.headers.get("retry-after") || 2) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
    return apiGet(path, { retry: retry - 1, params });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401
        ? " (ESA_ACCESS_TOKEN が無効です)"
        : res.status === 404
        ? " (記事が見つからない、またはトークンがこのチームにアクセスできません)"
        : "";
    throw new Error(`esa API ${res.status}${hint}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function getUser() {
  return apiGet(`/user`);
}

/**
 * @param {{team:string, postNumber:number}} ref
 */
export async function getPost({ team, postNumber }) {
  const t = team || config.esaDefaultTeam;
  if (!t) throw new Error("esa チーム名が特定できません (URL か ESA_DEFAULT_TEAM が必要)");
  const p = await apiGet(`/teams/${encodeURIComponent(t)}/posts/${postNumber}`);
  return {
    type: "esa",
    url: p.url,
    team: t,
    number: p.number,
    title: p.name,
    fullName: p.full_name,
    category: p.category || null,
    tags: p.tags || [],
    wip: !!p.wip,
    bodyMd: p.body_md || "",
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    author: p.created_by
      ? { name: p.created_by.name, screenName: p.created_by.screen_name }
      : null,
    updatedBy: p.updated_by
      ? { name: p.updated_by.name, screenName: p.updated_by.screen_name }
      : null,
  };
}

// ── 横断検索の esa ソース ───────────────────────────────────

/** ISO / YYYY-MM-DD → esa の日付演算子用 YYYY-MM-DD */
function ymd(s) {
  return String(s).slice(0, 10);
}

/** esa の記事 1 件を共通の「ヒット」形に正規化する。 */
function postToHit(p, terms) {
  const body = p.body_md || "";
  return {
    source: "esa",
    title: p.full_name || p.name || "(無題)",
    url: p.url || null,
    snippet: excerpt(body, terms),
    author: p.created_by?.screen_name || p.created_by?.name || null,
    timestamp: p.updated_at || p.created_at || null,
    extra: {
      number: p.number,
      category: p.category || null,
      tags: p.tags || [],
      wip: !!p.wip,
      createdAt: p.created_at || null,
      updatedAt: p.updated_at || null,
      updatedBy: p.updated_by?.screen_name || p.updated_by?.name || null,
      comments: p.comments_count ?? null,
      stars: p.stargazers_count ?? null,
    },
  };
}

/**
 * esa の記事を検索する。
 *
 * 関連語グループ (lib/expand.mjs) を渡すと esa の OR 検索に落として投げる。
 * esa の検索構文: 空白区切りは AND、`OR` で選択、`created:>YYYY-MM-DD` などが使える。
 *
 * @param {{query:string, groups?:{base:string,variants:string[]}[], team?:string,
 *          since?:string, until?:string, limit?:number,
 *          sort?:"updated"|"created"|"best_match"|"number"|"stars"}} opts
 * @returns {Promise<{hits:object[], warnings:string[], total:number}>}
 */
export async function searchPosts(opts = {}) {
  const team = opts.team || config.esaDefaultTeam;
  if (!team) {
    throw new Error("esa チーム名が特定できません (ESA_DEFAULT_TEAM を設定してください)");
  }

  const groups = opts.groups?.length ? opts.groups : null;
  const base = groups ? groupsToQuery(groups, { or: "OR", maxVariants: 6 }) : String(opts.query || "").trim();
  if (!base) throw new Error("検索キーワードが空です");

  const warnings = [];
  const parts = [base];
  if (opts.since) parts.push(`updated:>${ymd(opts.since)}`);
  if (opts.until) parts.push(`updated:<${ymd(opts.until)}`);
  const q = parts.join(" ");

  const limit = Math.min(Math.max(Number(opts.limit) || 40, 1), 100);
  const json = await apiGet(`/teams/${encodeURIComponent(team)}/posts`, {
    params: {
      q,
      per_page: String(limit),
      page: "1",
      sort: opts.sort || "best_match",
      order: "desc",
    },
  });

  const posts = json.posts || [];
  const total = json.total_count ?? posts.length;
  if (total > posts.length) {
    warnings.push(`${total} 件中 ${posts.length} 件のみ取得しました (--limit で増やせます)`);
  }

  const terms = groups
    ? [...new Set(groups.flatMap((g) => g.variants))]
    : String(opts.query || "").split(/[\s　]+/).filter(Boolean);

  return { hits: posts.map((p) => postToHit(p, terms)), warnings, total };
}
