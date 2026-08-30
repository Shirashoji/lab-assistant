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

export const core = {
  collectFromUrls: collectFromUrls as (urls: string[]) => Promise<CollectResult>,
  findDuplicateCandidates: findDuplicateCandidates as (q: {
    summary: string;
    start: string;
    end?: string;
    calendarId?: string;
  }) => Promise<DuplicateResult>,
  createEvent: createEvent as (input: EventInput) => Promise<CreatedEvent>,
  config: config as {
    timezone: string;
    calendarId: string;
  },
};

export type { EventInput };
