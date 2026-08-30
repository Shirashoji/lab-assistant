import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { core } from "./core.js";

const json = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * lab-assistant のツールを登録した MCP サーバーを生成する。
 * stdio / Streamable HTTP どちらのトランスポートからも使う。
 */
export function makeServer(): McpServer {
  const server = new McpServer({
    name: "lab-assistant",
    version: "0.1.0",
  });

  server.registerTool(
    "collect_context",
    {
      title: "Discord / esa の文脈を収集",
      description:
        "Discord メッセージ URL や esa 記事 URL を渡すと、予定抽出に必要な文脈をまとめて返す。" +
        "Discord は返信チェーン・スレッド・前後の分割メッセージ・本文中の esa リンクも辿る。",
      inputSchema: {
        urls: z
          .array(z.string().url())
          .min(1)
          .describe("Discord メッセージ URL / esa 記事 URL。複数可"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ urls }) => {
      const result = await core.collectFromUrls(urls);
      return json(result);
    }
  );

  server.registerTool(
    "find_duplicate_events",
    {
      title: "重複予定の候補を検索",
      description:
        "予定タイトルと開始時刻を渡すと、Google Calendar の前後 26 時間から重複候補を返す。" +
        "likelyMatch は機械的なヒント。最終判断は呼び出し側が意味的に行うこと。",
      inputSchema: {
        summary: z.string().describe("予定タイトル"),
        start: z
          .string()
          .describe("開始日時。ISO8601 (例 2026-09-01T19:00:00+09:00) または YYYY-MM-DD"),
        end: z.string().optional().describe("終了日時 (任意)"),
        calendarId: z.string().optional().describe("対象カレンダー ID (既定は設定値)"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ summary, start, end, calendarId }) => {
      const result = await core.findDuplicateCandidates({ summary, start, end, calendarId });
      return json(result);
    }
  );

  server.registerTool(
    "create_event",
    {
      title: "Google Calendar に予定を作成",
      description:
        "予定を 1 件作成する。作成前に必ず find_duplicate_events で重複を確認し、" +
        "同一予定が既にある場合は作成しないこと。description の末尾には出典 URL を含めること。",
      inputSchema: {
        summary: z.string().describe("予定タイトル"),
        start: z
          .string()
          .describe(
            "開始日時。時刻ありは ISO8601 でオフセット付き (例 2026-09-01T19:00:00+09:00)、終日は YYYY-MM-DD"
          ),
        end: z.string().optional().describe("終了日時 (同形式)。省略時は時刻ありで +1 時間、終日で翌日"),
        allDay: z.boolean().optional().describe("終日予定なら true"),
        location: z.string().optional().describe("場所 (オンラインなら URL やサービス名)"),
        description: z.string().optional().describe("補足。末尾に Source: <URL> を必ず入れる"),
        recurrence: z
          .array(z.string())
          .optional()
          .describe('RRULE の配列。例 ["RRULE:FREQ=WEEKLY;BYDAY=TU"]'),
        calendarId: z.string().optional().describe("対象カレンダー ID (既定は設定値)"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      const event = await core.createEvent(input);
      return json({ created: true, event });
    }
  );

  return server;
}
