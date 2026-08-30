// esa API v1 の薄いラッパ。依存ゼロ。
import { config } from "./config.mjs";

const API = "https://api.esa.io/v1";

async function apiGet(path, { retry = 1 } = {}) {
  const token = config.esaToken;
  if (!token) throw new Error("ESA_ACCESS_TOKEN が未設定です");
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": "calendar-agent/0.1.0",
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
