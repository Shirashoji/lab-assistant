// Slack Web API の薄いラッパ。依存ゼロ。
//
// ワークスペース検索 (search.messages) は **ユーザートークン限定**。Bot トークンでは不可。
// 自前アプリ `lab-assistant-search` (slack-app/ の manifest) を学科ワークスペースに
// インストールして得た User OAuth Token (xoxp-) を .env の SLACK_USER_TOKEN に入れる。
import { config } from "./config.mjs";
import { excerpt, tokenize } from "./text.mjs";

const API = "https://slack.com/api";

async function apiGet(method, params = {}, { retry = 2 } = {}) {
  const token = config.slackUserToken;
  if (!token) throw new Error("SLACK_USER_TOKEN が未設定です");
  const res = await fetch(`${API}/${method}?` + new URLSearchParams(params), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429 && retry > 0) {
    const wait = Number(res.headers.get("retry-after") || 3) * 1000;
    await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
    return apiGet(method, params, { retry: retry - 1 });
  }
  const json = await res.json().catch(() => ({}));
  if (!json.ok) {
    const hint =
      json.error === "missing_scope"
        ? ` (必要スコープ: ${json.needed}。slack-app の manifest を更新して再インストール)`
        : json.error === "not_authed" || json.error === "invalid_auth"
        ? " (SLACK_USER_TOKEN が無効か失効しています)"
        : json.error === "token_revoked"
        ? " (トークンが取り消されています。再インストールしてください)"
        : "";
    throw new Error(`Slack API ${method}: ${json.error || res.status}${hint}`);
  }
  return json;
}

export async function authTest() {
  return apiGet("auth.test");
}

/** ISO / YYYY-MM-DD → Slack 検索演算子用の YYYY-MM-DD */
function ymd(s) {
  return String(s).slice(0, 10);
}

/**
 * Slack のメッセージを検索する。
 * @param {{query:string, since?:string, until?:string, limit?:number,
 *          sort?:"timestamp"|"score", channels?:string[]}} opts
 * @returns {Promise<{hits:object[], warnings:string[], total:number}>}
 */
export async function searchMessages(opts = {}) {
  const { query, since, until, limit = 40, sort = "timestamp" } = opts;
  const terms = tokenize(query);
  if (terms.length === 0) throw new Error("検索キーワードが空です");
  const warnings = [];

  // Slack 検索演算子で期間・チャンネルを絞る
  const parts = [query];
  if (since) parts.push(`after:${ymd(since)}`);
  if (until) parts.push(`before:${ymd(until)}`);
  for (const ch of opts.channels || []) parts.push(`in:${ch}`);
  const q = parts.join(" ");

  const count = Math.min(Math.max(limit, 1), 100);
  const json = await apiGet("search.messages", {
    query: q,
    count: String(count),
    sort,
    sort_dir: "desc",
    highlight: "false",
  });
  const matches = json.messages?.matches || [];

  const hits = matches.slice(0, limit).map((m) => {
    const author = m.username || m.user || null;
    const ch = m.channel || {};
    return {
      source: "slack",
      title: `#${ch.name || ch.id || "?"}${author ? ` / ${author}` : ""}`,
      url: m.permalink || null,
      snippet: excerpt(m.text || "", terms),
      author,
      timestamp: m.ts ? new Date(Number(m.ts) * 1000).toISOString() : null,
      extra: {
        channelId: ch.id || null,
        channelName: ch.name || null,
        ts: m.ts || null,
        isPrivate: !!ch.is_private,
        isMpim: !!ch.is_mpim,
        team: m.team || null,
      },
    };
  });

  return { hits, warnings, total: json.messages?.total ?? hits.length };
}
