// esa API v1 の薄いラッパ。依存ゼロ。
import { config } from "./config.mjs";
import { excerpt, tokenize } from "./text.mjs";

const API = "https://api.esa.io/v1";

async function apiGet(path, { retry = 1 } = {}) {
  const token = config.esaToken;
  if (!token) throw new Error("ESA_ACCESS_TOKEN が未設定です");
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "lab-assistant/0.1.0",
    },
  });
  if ((res.status === 429 || res.status >= 500) && retry > 0) {
    const wait = Number(res.headers.get("retry-after") || 2) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 8000)));
    return apiGet(path, { retry: retry - 1 });
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

// ── 横断検索 (Phase 1) ─────────────────────────────────────

/**
 * esa の記事を全文検索する。
 * @param {{team?:string, q:string, perPage?:number, page?:number,
 *          since?:string, until?:string, limit?:number}} opts
 * @returns {Promise<{hits:object[], totalCount:number, warnings:string[]}>}
 */
export async function searchPosts(opts = {}) {
  const { q, perPage = 20, page = 1, since, until, limit = 20 } = opts;
  const team = opts.team || config.esaDefaultTeam;
  const warnings = [];
  if (!team) {
    throw new Error(
      "esa の検索にはチーム名が必要です。.env の ESA_DEFAULT_TEAM を設定してください。"
    );
  }

  // esa の検索クエリに更新日の下限を足す (since があれば)
  const parts = [q];
  if (since) parts.push(`updated:>${String(since).slice(0, 10)}`);
  if (until) parts.push(`updated:<${String(until).slice(0, 10)}`);
  const query = parts.filter(Boolean).join(" ");

  const params = new URLSearchParams({
    q: query,
    per_page: String(Math.min(perPage, 100)),
    page: String(page),
    sort: "updated",
    order: "desc",
  });
  const json = await apiGet(`/teams/${encodeURIComponent(team)}/posts?${params}`);
  const terms = tokenize(q);
  const hits = (json.posts || []).slice(0, limit).map((p) => ({
    source: "esa",
    title: p.full_name || p.name,
    url: p.url,
    snippet: excerpt(p.body_md || "", terms),
    author: p.updated_by?.screen_name || p.created_by?.screen_name || null,
    timestamp: p.updated_at || p.created_at || null,
    extra: {
      number: p.number,
      category: p.category || null,
      tags: p.tags || [],
      wip: !!p.wip,
      team,
    },
  }));
  return { hits, totalCount: json.total_count ?? hits.length, warnings };
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
