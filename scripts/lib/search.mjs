// 研究室の各ソースを横断検索する共通ロジック。依存ゼロ。
// bin/search.mjs と (将来) mcp-server / スキルから使う。
//
// ここでコードとして検索するのは「公式 MCP が無い / 精密な制御が要る」ソース:
//   - discord … Bot は検索 API 不可。直近メッセージを取得してフィルタする
//   - calendar … ゼミカレンダー限定の期間 + キーワード検索
//   - slack   … 自前アプリのユーザートークンで search.messages (管理者承認済み前提)
//   - github  … REST search API (Issue/PR・コード・コミット・リポジトリ) を PAT で検索
//   - drive   … Drive API v3 の files.list (fullText) を既存の Google OAuth で叩く
// esa は公式 MCP (.mcp.json でバンドル) 側で検索し、
// スキルがそれらと本モジュールの結果をまとめる。
//
// すべてのソースは共通の「ヒット」形に正規化して返す:
//   {
//     source: "discord" | "calendar" | ...,
//     title, url, snippet, author, timestamp,   // timestamp は ISO8601
//     extra: object                              // ソース固有の付加情報
//   }

import { config } from "./config.mjs";
import { searchMessages as searchDiscord } from "./discord.mjs";
import { searchMessages as searchSlack } from "./slack.mjs";
import { searchEvents as searchCalendar } from "./gcal.mjs";
import { searchGitHub } from "./github.mjs";
import { searchFiles as searchDrive } from "./gdrive.mjs";

/** このモジュールがコードとして検索できるソース。 */
export const AVAILABLE_SOURCES = ["calendar", "slack", "discord", "github", "drive"];

/** そのソースを検索する前提が整っているか (.env)。 */
export function sourceReadiness() {
  return {
    calendar: {
      ready: !!(config.googleClientId && config.googleClientSecret && config.googleRefreshToken),
      reason: "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN",
    },
    slack: {
      ready: !!config.slackUserToken,
      reason: "SLACK_USER_TOKEN (自前アプリ lab-assistant-search の xoxp- トークン)",
    },
    discord: {
      ready: !!config.discordToken,
      reason: "DISCORD_BOT_TOKEN (対象は DISCORD_GUILD_IDS、未指定なら Bot の全参加ギルド)",
    },
    github: {
      ready: !!config.githubToken,
      reason: "GITHUB_TOKEN (対象は GITHUB_ORGS / GITHUB_REPOS。権限は docs/GITHUB-TOKEN.md)",
    },
    drive: {
      ready: !!(config.googleClientId && config.googleClientSecret && config.googleRefreshToken),
      reason: "Google OAuth (drive.readonly スコープ込みで auth-google.mjs を再実行)",
    },
  };
}

const RUNNERS = {
  async calendar(query, opts) {
    const { hits, warnings } = await searchCalendar({
      q: query,
      since: opts.since,
      until: opts.until,
      calendarId: opts.calendarId,
    });
    return { hits, warnings };
  },
  async slack(query, opts) {
    const { hits, warnings, total } = await searchSlack({
      query,
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      channels: opts.channels,
    });
    const coverage =
      total != null && total > hits.length ? `${total} 件中 ${hits.length} 件` : undefined;
    return { hits, warnings, coverage };
  },
  async discord(query, opts) {
    const { hits, warnings, searchedChannels, candidateChannels, forbiddenChannels } = await searchDiscord({
      query,
      since: opts.since,
      until: opts.until,
      guildIds: config.discordGuildIds,
      channelAllowList: opts.channels?.length
        ? opts.channels
        : config.discordSearchChannelIds,
      maxPagesPerChannel: opts.maxPagesPerChannel,
      maxChannels: opts.maxChannels,
      limit: opts.limit,
    });
    const coverage =
      searchedChannels != null
        ? `${searchedChannels}/${candidateChannels} チャンネル` +
          (forbiddenChannels ? ` ・権限無しで除外 ${forbiddenChannels} 件` : "") +
          (opts.since ? "" : " ・各チャンネル直近100件のみ(--since で期間指定可)")
        : undefined;
    return { hits, warnings, coverage };
  },
  async github(query, opts) {
    const { hits, warnings, total } = await searchGitHub({
      query,
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      orgs: opts.orgs?.length ? opts.orgs : config.githubOrgs,
      repos: opts.repos?.length ? opts.repos : config.githubRepos,
      kinds: opts.kinds,
      enrichCode: opts.enrichCode,
    });
    const coverage = total != null ? `${total} 件中 ${hits.length} 件` : undefined;
    return { hits, warnings, coverage };
  },
  async drive(query, opts) {
    const { hits, warnings, hasMore } = await searchDrive({
      query,
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      folderIds: opts.folderIds?.length ? opts.folderIds : config.driveFolderIds,
      mimeTypes: opts.mimeTypes?.length ? opts.mimeTypes : config.driveMimeTypes,
    });
    const coverage = hasMore
      ? `上位 ${hits.length} 件のみ (--limit / --since で絞り込み可)`
      : `${hits.length} 件`;
    return { hits, warnings, coverage };
  },
};

/**
 * 横断検索を実行する。
 * @param {string} query
 * @param {{sources?:string[], since?:string, until?:string, limit?:number,
 *          sort?:"relevance"|"newest"|"oldest", channels?:string[], calendarId?:string,
 *          maxChannels?:number, maxPagesPerChannel?:number, orgs?:string[], repos?:string[],
 *          kinds?:string[], enrichCode?:boolean, folderIds?:string[], mimeTypes?:string[]}} [opts]
 */
export async function searchAll(query, opts = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("検索キーワードが空です");

  const readiness = sourceReadiness();
  const requested =
    opts.sources && opts.sources.length ? opts.sources : AVAILABLE_SOURCES;

  const searched = [];
  const skipped = [];
  const warnings = [];
  const perSource = {};
  const coverage = {};

  const runs = requested.map(async (src) => {
    const runner = RUNNERS[src];
    if (!runner) {
      skipped.push({ source: src, reason: "未対応のソース名" });
      return [];
    }
    if (!readiness[src]?.ready) {
      skipped.push({ source: src, reason: `未設定: ${readiness[src]?.reason || ""}` });
      return [];
    }
    try {
      const { hits, warnings: w, coverage: cov } = await runner(q, opts);
      searched.push(src);
      perSource[src] = hits.length;
      if (cov) coverage[src] = cov;
      if (w?.length) warnings.push(...w.map((m) => `[${src}] ${m}`));
      return hits;
    } catch (e) {
      warnings.push(`[${src}] 検索に失敗: ${e.message}`);
      skipped.push({ source: src, reason: e.message });
      return [];
    }
  });

  let hits = (await Promise.all(runs)).flat();
  hits = dedupeHits(hits);
  hits.sort(makeSorter(opts.sort));
  if (opts.limit) hits = hits.slice(0, opts.limit);

  return {
    query: q,
    generatedAt: new Date().toISOString(),
    window: { since: opts.since || null, until: opts.until || null },
    sort: opts.sort || "relevance",
    searched,
    skipped,
    countBySource: perSource,
    coverage,
    hits,
    warnings,
  };
}

/**
 * 並び順:
 *  - "relevance" (既定): 今日からの時間的な近さ順 (過去も未来も、近いものが上)。
 *    「◯◯はいつ?」でも「最近の◯◯の話」でも直感に合う。
 *  - "newest": タイムスタンプの新しい順。
 *  - "oldest": 古い順。
 */
function makeSorter(mode) {
  const ts = (h) => {
    const t = Date.parse(h.timestamp || "");
    return Number.isNaN(t) ? null : t;
  };
  if (mode === "newest") return (a, b) => (ts(b) ?? -Infinity) - (ts(a) ?? -Infinity);
  if (mode === "oldest") return (a, b) => (ts(a) ?? Infinity) - (ts(b) ?? Infinity);
  const now = Date.now();
  const dist = (h) => {
    const t = ts(h);
    return t === null ? Infinity : Math.abs(t - now);
  };
  return (a, b) => dist(a) - dist(b);
}

/** URL が同じヒットは 1 つにまとめる。 */
export function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = h.url || `${h.source}:${h.title}:${h.timestamp}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/** 人間向けの短い一覧表示。 */
export function formatHits(result) {
  const lines = [];
  lines.push(`"${result.query}" の検索結果 — ${result.hits.length} 件`);
  lines.push(
    `対象: ${result.searched.join(", ") || "(なし)"}` +
      (result.skipped.length
        ? ` / 除外: ${result.skipped.map((s) => s.source).join(", ")}`
        : "")
  );
  for (const [src, cov] of Object.entries(result.coverage || {})) {
    lines.push(`  ${src} 範囲: ${cov}`);
  }
  lines.push("");
  for (const h of result.hits) {
    const when = h.timestamp ? h.timestamp.slice(0, 16).replace("T", " ") : "日時不明";
    lines.push(`● [${h.source}] ${h.title}  (${when})`);
    if (h.snippet) lines.push(`  ${h.snippet}`);
    if (h.url) lines.push(`  ${h.url}`);
    lines.push("");
  }
  if (result.warnings.length) {
    lines.push("⚠ 警告:");
    for (const w of result.warnings) lines.push(`  - ${w}`);
  }
  return lines.join("\n");
}
