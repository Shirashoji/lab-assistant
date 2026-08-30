// 「このトピックに詳しいのは誰か」を、横断検索のヒットから推定する。依存ゼロ。
//
// 各ソース (esa / Slack / Discord / GitHub / Drive / Calendar) の検索結果は
// lib/search.mjs の共通ヒット形に正規化されている:
//   { source, title, url, snippet, author, timestamp, extra }
// ここではそれを **人物ごと** に畳み込み、根拠 (証拠となる投稿・記事) 付きで並べ替える。
//
// 判定は機械的なヒント。最終的な言い回し (「◯◯さんが詳しそう」) は呼び出し側が
// 証拠を読んだうえで書くこと。

import { normalizeText, tokenize } from "./text.mjs";

/** ソースごとの重み。「その人が書いたまとまった成果物」ほど強い証拠とみなす。 */
export const SOURCE_WEIGHT = {
  esa: 3.0, // 記事を書いている = 一次資料の書き手
  github: 2.5, // コード / Issue / PR を書いている
  drive: 2.0, // 資料・スライドの作成者 / 更新者
  discord: 1.0, // 発言
  slack: 1.0, // 発言
  calendar: 0.4, // 発表予定など。弱い証拠
};

/** 証拠の鮮度の半減期 (日)。古い発言ほど重みを落とす。 */
const DEFAULT_HALF_LIFE_DAYS = 365;

/** 名寄せ用のキー。表記ゆれ (空白 / @ / 全角) を吸収する。 */
export function identityKey(name) {
  return normalizeText(String(name || ""))
    .replace(/^@+/, "")
    .replace(/\s+/g, "")
    .replace(/[()（）\[\]]/g, "");
}

/** Slack の生 ID (U01ABCDEF / W01ABCDEF) など、人間に読めない表示名か。 */
export function looksLikeRawId(name) {
  const s = String(name || "");
  return /^[UW][A-Z0-9]{6,}$/.test(s) || /^\d{15,}$/.test(s);
}

/**
 * ヒット配列を人物ごとに畳み込む。
 *
 * @param {Array<object>} hits lib/search.mjs 形のヒット (esa MCP の結果を手で
 *   この形に直して混ぜてもよい)
 * @param {{query?:string, now?:Date|string, minHits?:number, top?:number,
 *          evidencePerExpert?:number, halfLifeDays?:number, includeBots?:boolean,
 *          aliases?:Record<string,string>, sourceWeight?:Record<string,number>}} [opts]
 * @returns {{query:string|null, generatedAt:string, totalHits:number,
 *            attributedHits:number, unattributedHits:number,
 *            countBySource:Record<string,number>, experts:Array<object>, notes:string[]}}
 */
export function aggregateExperts(hits, opts = {}) {
  const list = Array.isArray(hits) ? hits : hits?.hits || [];
  const now = opts.now ? new Date(opts.now) : new Date();
  const halfLife = (opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS) * 86400_000;
  const weights = { ...SOURCE_WEIGHT, ...(opts.sourceWeight || {}) };
  const terms = tokenize(opts.query || "");
  const aliases = normalizeAliases(opts.aliases);
  const notes = [];

  const people = new Map();
  const countBySource = {};
  let unattributed = 0;
  let botHits = 0;

  for (const h of list) {
    countBySource[h.source] = (countBySource[h.source] || 0) + 1;

    const rawName = pickAuthor(h);
    if (!rawName) {
      unattributed++;
      continue;
    }
    if (!opts.includeBots && isBot(h, rawName)) {
      botHits++;
      continue;
    }
    const key = aliases[identityKey(rawName)] || identityKey(rawName);
    if (!key) {
      unattributed++;
      continue;
    }

    let p = people.get(key);
    if (!p) {
      p = {
        key,
        name: rawName,
        displayNames: new Set(),
        handles: {}, // source -> Set(表示名)
        score: 0,
        hitCount: 0,
        countBySource: {},
        firstSeen: null,
        lastSeen: null,
        evidence: [],
      };
      people.set(key, p);
    }

    p.displayNames.add(rawName);
    (p.handles[h.source] ||= new Set()).add(rawName);
    p.hitCount++;
    p.countBySource[h.source] = (p.countBySource[h.source] || 0) + 1;

    const ts = Date.parse(h.timestamp || "");
    if (!Number.isNaN(ts)) {
      const iso = new Date(ts).toISOString();
      if (!p.firstSeen || iso < p.firstSeen) p.firstSeen = iso;
      if (!p.lastSeen || iso > p.lastSeen) p.lastSeen = iso;
    }

    const w = weights[h.source] ?? 1.0;
    const recency = Number.isNaN(ts) ? 0.5 : Math.pow(0.5, Math.abs(now - ts) / halfLife);
    const density = termDensity(h, terms);
    const contribution = w * (0.35 + 0.65 * recency) * (1 + density);

    p.score += contribution;
    p.evidence.push({ ...toEvidence(h), weight: round(contribution) });
  }

  const evidencePerExpert = opts.evidencePerExpert ?? 5;
  const minHits = opts.minHits ?? 1;

  let experts = [...people.values()]
    .filter((p) => p.hitCount >= minHits)
    .map((p) => {
      // 複数ソースに顔を出している人は「本当に詳しい」可能性が高い。
      const sourceCount = Object.keys(p.countBySource).length;
      const score = round(p.score * (1 + 0.25 * (sourceCount - 1)));
      p.evidence.sort((a, b) => b.weight - a.weight);
      return {
        name: bestDisplayName(p),
        key: p.key,
        score,
        hitCount: p.hitCount,
        sourceCount,
        countBySource: p.countBySource,
        firstSeen: p.firstSeen,
        lastSeen: p.lastSeen,
        handles: Object.fromEntries(
          Object.entries(p.handles).map(([s, set]) => [s, [...set]])
        ),
        needsNameResolution: [...p.displayNames].every(looksLikeRawId),
        evidence: p.evidence.slice(0, evidencePerExpert),
        evidenceTotal: p.evidence.length,
      };
    })
    .sort((a, b) => b.score - a.score || b.hitCount - a.hitCount);

  if (opts.top) experts = experts.slice(0, opts.top);

  if (botHits) {
    notes.push(
      `Bot / 自動投稿によるヒットを ${botHits} 件除外しました (--include-bots で含められます)。`
    );
  }
  if (unattributed) {
    notes.push(
      `投稿者が特定できなかったヒットが ${unattributed} 件あります (Calendar の予定など)。`
    );
  }
  if (experts.some((e) => e.needsNameResolution)) {
    notes.push(
      "表示名を解決できなかった人がいます (Slack の users:read スコープ不足など)。ID のまま出しています。"
    );
  }
  if (experts.length && experts[0].hitCount < 2) {
    notes.push("最上位でも根拠が 1 件しかありません。断定せず「候補」として提示してください。");
  }

  return {
    query: opts.query || null,
    generatedAt: now.toISOString(),
    totalHits: list.length,
    attributedHits: list.length - unattributed - botHits,
    unattributedHits: unattributed,
    botHits,
    countBySource,
    experts,
    notes,
  };
}

/** GitHub 連携・リマインダーなどの自動投稿は「詳しい人」ではないので除く。 */
const BOT_NAME_PATTERN =
  /^(github|gitlab|zapier|ifttt|webhook|hubot|dependabot|renovate|カレンダー|reminder|リマインド|.*\[?bot\]?)$/i;

function isBot(h, name) {
  if (h.extra?.bot === true) return true;
  if (h.extra?.isBot === true) return true;
  if (h.extra?.subtype === "bot_message") return true;
  return BOT_NAME_PATTERN.test(String(name).trim());
}

/** ヒットから投稿者名を取り出す。ソース固有の置き場所もひととおり見る。 */
function pickAuthor(h) {
  const cand =
    h.author ||
    h.extra?.author ||
    h.extra?.login ||
    h.extra?.owners?.[0] ||
    h.extra?.lastModifiedBy ||
    null;
  const name = typeof cand === "string" ? cand : cand?.name || cand?.displayName || null;
  return name ? String(name).trim() : null;
}

/** 抜粋の中に検索語がどれだけ濃く出るか (0〜0.5 程度の加点)。 */
function termDensity(h, terms) {
  if (!terms.length) return 0;
  const hay = normalizeText(
    [h.title, h.snippet, h.extra?.path, h.extra?.channelName].filter(Boolean).join(" ")
  );
  if (!hay) return 0;
  let n = 0;
  for (const t of terms) {
    const occurrences = hay.split(t).length - 1;
    if (occurrences > 0) n += Math.min(occurrences, 3);
  }
  return Math.min(0.5, (n / terms.length) * 0.25);
}

function toEvidence(h) {
  return {
    source: h.source,
    title: h.title || null,
    url: h.url || null,
    snippet: h.snippet || null,
    timestamp: h.timestamp || null,
    where: h.extra?.channelName ? `#${h.extra.channelName}` : h.extra?.repo || h.extra?.kind || null,
  };
}

/** 表示名の候補から、いちばん人間に読めるものを選ぶ。 */
function bestDisplayName(p) {
  const names = [...p.displayNames];
  const readable = names.filter((n) => !looksLikeRawId(n));
  const pool = readable.length ? readable : names;
  return pool.sort((a, b) => b.length - a.length)[0];
}

/** "田中=tanaka, taro=tanaka" → { 田中: tanaka のキー, ... } */
function normalizeAliases(aliases) {
  const out = {};
  for (const [from, to] of Object.entries(aliases || {})) {
    const f = identityKey(from);
    const t = identityKey(to);
    if (f && t) out[f] = t;
  }
  return out;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

/** 人間向けの短い一覧表示。 */
export function formatExperts(result) {
  const lines = [];
  lines.push(
    `"${result.query ?? ""}" に詳しそうな人 — ${result.experts.length} 名` +
      ` (根拠 ${result.attributedHits}/${result.totalHits} 件)`
  );
  const bySrc = Object.entries(result.countBySource)
    .map(([s, n]) => `${s}:${n}`)
    .join(" ");
  if (bySrc) lines.push(`ヒット内訳: ${bySrc}`);
  lines.push("");

  let rank = 0;
  for (const e of result.experts) {
    rank++;
    const srcs = Object.entries(e.countBySource)
      .map(([s, n]) => `${s} ${n}`)
      .join(" / ");
    const span =
      e.firstSeen && e.lastSeen
        ? `${e.firstSeen.slice(0, 10)}〜${e.lastSeen.slice(0, 10)}`
        : "期間不明";
    lines.push(`${rank}. ${e.name}  (score ${e.score} ・ ${e.hitCount} 件 ・ ${srcs} ・ ${span})`);
    for (const ev of e.evidence) {
      const when = ev.timestamp ? ev.timestamp.slice(0, 10) : "日時不明";
      lines.push(`   - [${ev.source}] ${ev.title || "(無題)"} (${when})`);
      if (ev.snippet) lines.push(`     ${ev.snippet}`);
      if (ev.url) lines.push(`     ${ev.url}`);
    }
    if (e.evidenceTotal > e.evidence.length) {
      lines.push(`   … ほか ${e.evidenceTotal - e.evidence.length} 件`);
    }
    lines.push("");
  }

  if (result.notes.length) {
    lines.push("補足:");
    for (const n of result.notes) lines.push(`  - ${n}`);
  }
  return lines.join("\n");
}
