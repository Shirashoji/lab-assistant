// lab-assistant のコアロジック (scripts/lib/*.mjs) への型なしブリッジ。
// これらは依存ゼロの素の ESM モジュールで型定義を持たないため @ts-ignore で読み込む。
// 実行時 (tsx / node) は相対パスでそのまま解決される。

// @ts-ignore -- plain JS ESM, ships without type declarations
import { collectFromUrls } from "../../scripts/lib/collect.mjs";
// @ts-ignore
import { findDuplicateCandidates } from "../../scripts/lib/dedupe.mjs";
// @ts-ignore
import { createEvent } from "../../scripts/lib/gcal.mjs";
// @ts-ignore
import { config } from "../../scripts/lib/config.mjs";
// @ts-ignore
import { searchAll, AVAILABLE_SOURCES, sourceReadiness } from "../../scripts/lib/search.mjs";
// @ts-ignore
import { aggregateExperts } from "../../scripts/lib/experts.mjs";
// @ts-ignore
import { resolveUserNames } from "../../scripts/lib/slack.mjs";

type CollectResult = {
  inputUrls: string[];
  generatedAt: string;
  sources: unknown[];
  warnings: string[];
};

type DuplicateResult = {
  query: { summary: string; start: string };
  window: { timeMin: string; timeMax: string };
  candidates: Array<{
    id: string;
    summary: string;
    start: unknown;
    end: unknown;
    location: string | null;
    htmlLink: string;
    startDiffMinutes: number | null;
    sameDay: boolean;
    titleOverlap: boolean;
    likelyMatch: boolean;
  }>;
};

type EventInput = {
  summary: string;
  start: string;
  end?: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  recurrence?: string[];
  calendarId?: string;
};

type CreatedEvent = {
  id: string;
  htmlLink: string;
  summary: string;
  start: unknown;
  end: unknown;
};

type Hit = {
  source: string;
  title: string | null;
  url: string | null;
  snippet: string | null;
  author: string | null;
  timestamp: string | null;
  extra?: Record<string, unknown>;
};

type SearchResult = {
  query: string;
  generatedAt: string;
  window: { since: string | null; until: string | null };
  searched: string[];
  skipped: Array<{ source: string; reason: string }>;
  countBySource: Record<string, number>;
  coverage: Record<string, string>;
  hits: Hit[];
  warnings: string[];
};

type SearchOpts = {
  sources?: string[];
  since?: string;
  until?: string;
  limit?: number;
  sort?: "relevance" | "newest" | "oldest";
  channels?: string[];
  calendarId?: string;
  kinds?: string[];
  enrichCode?: boolean;
};

type ExpertResult = {
  query: string | null;
  generatedAt: string;
  totalHits: number;
  attributedHits: number;
  experts: Array<{
    name: string;
    score: number;
    hitCount: number;
    countBySource: Record<string, number>;
    evidence: Array<{ source: string; title: string | null; url: string | null; snippet: string | null; timestamp: string | null }>;
  }>;
  notes: string[];
};

const searchAllTyped = searchAll as (q: string, opts?: SearchOpts) => Promise<SearchResult>;

/**
 * Slack のヒットで投稿者が生 ID (U01ABCDEF) のままのものを表示名に直す。
 * users:read スコープが無ければ黙って ID のままにする。
 */
async function resolveSlackAuthors(hits: Hit[]): Promise<void> {
  const raw = (n: string | null) => !!n && (/^[UW][A-Z0-9]{6,}$/.test(n) || /^\d{15,}$/.test(n));
  const ids = hits.filter((h) => h.source === "slack" && raw(h.author)).map((h) => h.author as string);
  if (!ids.length) return;
  try {
    const names = (await (resolveUserNames as (ids: string[]) => Promise<Record<string, string>>)(ids)) || {};
    for (const h of hits) {
      if (h.source === "slack" && h.author && names[h.author]) h.author = names[h.author];
    }
  } catch {
    /* 解決できなくても検索結果自体は返す */
  }
}

export const core = {
  collectFromUrls: collectFromUrls as (urls: string[]) => Promise<CollectResult>,
  findDuplicateCandidates: findDuplicateCandidates as (q: {
    summary: string;
    start: string;
    end?: string;
    calendarId?: string;
  }) => Promise<DuplicateResult>,
  createEvent: createEvent as (input: EventInput) => Promise<CreatedEvent>,
  availableSources: AVAILABLE_SOURCES as string[],
  sourceReadiness: sourceReadiness as () => Record<string, { ready: boolean; reason: string }>,

  /** 研究室の各ソースを横断検索する。 */
  async searchLab(query: string, opts: SearchOpts = {}): Promise<SearchResult> {
    const result = await searchAllTyped(query, opts);
    await resolveSlackAuthors(result.hits);
    return result;
  },

  /** 横断検索の結果を人物ごとに畳み込み、「詳しそうな人」を根拠付きで返す。 */
  async findExpert(
    query: string,
    opts: SearchOpts & {
      top?: number;
      evidencePerExpert?: number;
      extraHits?: Hit[];
      includeBots?: boolean;
    } = {}
  ): Promise<ExpertResult & Pick<SearchResult, "window" | "searched" | "skipped" | "coverage" | "warnings">> {
    // 人物ごとに畳み込むので、検索そのものは広めに取る。
    // 誰が書いたかが主題なので、code ヒットの著者補完も既定で有効にする。
    const result = await searchAllTyped(query, {
      ...opts,
      limit: opts.limit ?? 120,
      sort: "newest",
      enrichCode: opts.enrichCode ?? true,
    });
    const hits = [...result.hits, ...(opts.extraHits || [])];
    await resolveSlackAuthors(hits);

    const experts = (aggregateExperts as (h: Hit[], o: object) => ExpertResult)(hits, {
      query,
      top: opts.top ?? 8,
      evidencePerExpert: opts.evidencePerExpert ?? 5,
      includeBots: !!opts.includeBots,
    });

    return {
      ...experts,
      window: result.window,
      searched: result.searched,
      skipped: result.skipped,
      coverage: result.coverage,
      warnings: result.warnings,
    };
  },

  config: config as {
    timezone: string;
    calendarId: string;
  },
};

export type { EventInput, Hit, SearchOpts };
