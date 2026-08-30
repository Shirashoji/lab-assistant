#!/usr/bin/env node
// ゼミの Google Calendar 専用 MCP サーバー (stdio・依存ゼロ)。
//
// .mcp.json でバンドルし、Claude Code が `plugin:lab-assistant:seminar-calendar` として登録する。
// すべての操作は .env の GOOGLE_CALENDAR_ID(= ゼミカレンダー)に固定される。
// Claude アプリ標準の Google Calendar コネクタと混同させないためのもの。
//
// 公開ツール:
//   list_events           期間内の予定を一覧
//   search_events         キーワード + 期間で予定を検索
//   find_duplicate_events 作成予定の重複候補を洗い出す(同一判断は呼び出し側)
//   create_event          予定を作成(※ユーザー承認を得てから呼ぶこと)
//   list_calendars        アクセスできるカレンダーと権限(セットアップ確認用)

import { runMcpServer } from "../lib/mcp-stdio.mjs";
import { config } from "../lib/config.mjs";
import { listEvents, searchEvents, createEvent, listCalendars } from "../lib/gcal.mjs";
import { findDuplicateCandidates } from "../lib/dedupe.mjs";

const CAL = config.calendarId; // ゼミカレンダー ID に固定
const DAY = 864e5;

const tools = [
  {
    name: "list_events",
    description:
      "ゼミの Google Calendar の予定を期間指定で一覧する。timeMin/timeMax は ISO8601。" +
      "省略時は「今日〜60日後」。",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string", description: "開始(ISO8601)。既定は現在時刻" },
        timeMax: { type: "string", description: "終了(ISO8601)。既定は60日後" },
      },
    },
    handler: async (a) => {
      const now = Date.now();
      const timeMin = a.timeMin ? new Date(a.timeMin).toISOString() : new Date(now).toISOString();
      const timeMax = a.timeMax ? new Date(a.timeMax).toISOString() : new Date(now + 60 * DAY).toISOString();
      const events = await listEvents({ timeMin, timeMax, calendarId: CAL });
      return { calendarId: CAL, timeMin, timeMax, count: events.length, events };
    },
  },
  {
    name: "search_events",
    description:
      "ゼミの Google Calendar をキーワードで検索する。since/until は ISO8601 か YYYY-MM-DD。" +
      "省略時は「30日前〜400日後」。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "検索キーワード" },
        since: { type: "string", description: "期間の下限(省略可)" },
        until: { type: "string", description: "期間の上限(省略可)" },
      },
      required: ["query"],
    },
    handler: async (a) => {
      if (!a.query) throw new Error("query は必須です");
      const { hits } = await searchEvents({ q: a.query, since: a.since, until: a.until, calendarId: CAL });
      return { calendarId: CAL, query: a.query, count: hits.length, hits };
    },
  },
  {
    name: "find_duplicate_events",
    description:
      "作成しようとしている予定と重複しそうな既存予定を、開始時刻の前後26時間から洗い出す。" +
      "『同じ予定かどうか』の最終判断は呼び出し側が意味的に行うこと(likelyMatch は機械的ヒント)。",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "予定タイトル" },
        start: { type: "string", description: "開始日時(ISO8601、終日は YYYY-MM-DD)" },
        end: { type: "string", description: "終了日時(省略可)" },
      },
      required: ["summary", "start"],
    },
    handler: async (a) => {
      if (!a.summary || !a.start) throw new Error("summary と start は必須です");
      return findDuplicateCandidates({ summary: a.summary, start: a.start, end: a.end, calendarId: CAL });
    },
  },
  {
    name: "create_event",
    description:
      "ゼミの Google Calendar に予定を作成する。**必ずユーザーの承認を得てから呼ぶこと。** " +
      "作成前に find_duplicate_events で重複を確認するのが望ましい。",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        start: { type: "string", description: "ISO8601(オフセット付き)。終日は YYYY-MM-DD" },
        end: { type: "string", description: "省略時は時刻ありで+1時間 / 終日で翌日" },
        location: { type: "string" },
        description: { type: "string", description: "末尾に出典 `Source: <URL>(...)` を入れる" },
        allDay: { type: "boolean" },
        recurrence: { type: "array", items: { type: "string" }, description: "RRULE 配列" },
      },
      required: ["summary", "start"],
    },
    handler: async (a) => {
      if (!a.summary || !a.start) throw new Error("summary と start は必須です");
      const ev = await createEvent({
        summary: a.summary,
        start: a.start,
        end: a.end,
        location: a.location,
        description: a.description,
        allDay: a.allDay,
        recurrence: a.recurrence,
        calendarId: CAL,
      });
      return { created: true, calendarId: CAL, event: ev };
    },
  },
  {
    name: "list_calendars",
    description: "OAuth でアクセスできるカレンダーと権限(accessRole)を一覧する。対象カレンダーの確認用。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const list = await listCalendars();
      const items = (list.items || []).map((c) => ({
        id: c.id,
        summary: c.summary,
        accessRole: c.accessRole,
        primary: !!c.primary,
        target: c.id === CAL,
      }));
      return { targetCalendarId: CAL, calendars: items };
    },
  },
];

runMcpServer({ name: "seminar-calendar", version: "0.2.0", tools });
