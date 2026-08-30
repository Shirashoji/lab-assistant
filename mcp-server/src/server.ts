import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { core } from "./core.js";
import type { Hit } from "./core.js";

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


  server.registerTool(
    "search_lab",
    {
      title: "研究室の情報基盤を横断検索",
      description:
        "Google Calendar (ゼミ) / Slack (学科) / Discord / GitHub / Google Drive を横断して検索する。" +
        "esa は別サーバー (esa MCP) 側で検索すること。" +
        "結果は共通形のヒット (source / title / url / snippet / author / timestamp / extra) と、" +
        "searched / skipped / coverage / warnings を返すので、回答には必ず出典 URL と" +
        "「見た範囲」を添えること。",
      inputSchema: {
        query: z.string().describe("検索キーワード。略称・言い換えは呼び出し側で複数回試すこと"),
        sources: z
          .array(z.enum(["calendar", "slack", "discord", "github", "drive"]))
          .optional()
          .describe("検索するソース。省略時は設定済みの全ソース"),
        since: z.string().optional().describe("この日以降 (YYYY-MM-DD)。省略時はソースごとの既定"),
        until: z.string().optional().describe("この日まで (YYYY-MM-DD)"),
        limit: z.number().int().min(1).max(200).optional().describe("最大ヒット数 (既定 40)"),
        sort: z
          .enum(["relevance", "newest", "oldest"])
          .optional()
          .describe("並び順。relevance (既定) は今日からの時間的な近さ順"),
        channels: z.string().array().optional().describe("Slack / Discord のチャンネル ID で絞る"),
        kinds: z
          .array(z.enum(["issues", "code", "commits", "repos", "discussions"]))
          .optional()
          .describe("GitHub の検索種別。既定は issues と code"),
        enrichCode: z
          .boolean()
          .optional()
          .describe(
            "GitHub の code ヒットに著者と日付を補う (先頭 10 件、1 件につき 1 リクエスト増える)"
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, sources, since, until, limit, sort, channels, kinds, enrichCode }) => {
      const result = await core.searchLab(query, {
        sources,
        since,
        until,
        limit: limit ?? 40,
        sort,
        channels,
        kinds,
        enrichCode,
      });
      return json(result);
    }
  );

  server.registerTool(
    "find_expert",
    {
      title: "トピックに詳しい人を探す",
      description:
        "あるトピック (例 MCP / トーラス / 根付き木) について、Slack / Discord / GitHub / Drive / Calendar を" +
        "横断検索し、投稿者ごとに畳み込んで「詳しそうな人」を根拠 (投稿・記事のリンク) 付きで返す。" +
        "esa の記事は最も強い根拠になるので、esa MCP で検索した結果を extraHits に共通ヒット形で渡すこと。" +
        "score は機械的なヒントに過ぎない。必ず evidence の中身を読み、" +
        "「単に単語が出てくるだけ」の人は落としてから答えること。",
      inputSchema: {
        query: z.string().describe("詳しい人を探したいトピック"),
        sources: z
          .array(z.enum(["calendar", "slack", "discord", "github", "drive"]))
          .optional()
          .describe("検索するソース。省略時は設定済みの全ソース"),
        since: z
          .string()
          .optional()
          .describe("この日以降 (YYYY-MM-DD)。専門性は蓄積するので 2 年程度さかのぼるとよい"),
        until: z.string().optional().describe("この日まで (YYYY-MM-DD)"),
        top: z.number().int().min(1).max(30).optional().describe("返す人数 (既定 8)"),
        evidencePerExpert: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("1 人あたりの根拠の件数 (既定 5)"),
        includeBots: z
          .boolean()
          .optional()
          .describe("GitHub 連携などの Bot 投稿も含めるか (既定 false)"),
        extraHits: z
          .array(
            z.object({
              source: z.string().describe('ソース名。esa MCP の結果なら "esa"'),
              title: z.string().nullable().optional(),
              url: z.string().nullable().optional(),
              snippet: z.string().nullable().optional(),
              author: z.string().nullable().optional().describe("書いた人の表示名"),
              timestamp: z.string().nullable().optional().describe("ISO8601"),
            })
          )
          .optional()
          .describe("esa など他の MCP で検索した結果を共通ヒット形で混ぜる"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, sources, since, until, top, evidencePerExpert, includeBots, extraHits }) => {
      const result = await core.findExpert(query, {
        sources,
        since,
        until,
        top,
        evidencePerExpert,
        includeBots,
        extraHits: (extraHits || []) as Hit[],
      });
      return json(result);
    }
  );

  server.registerTool(
    "list_search_sources",
    {
      title: "検索できるソースと準備状況",
      description:
        "横断検索に使えるソースと、それぞれ .env の設定が済んでいるかを返す。" +
        "検索結果が薄いときに「そもそも設定されていないのか」を切り分けるのに使う。",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => json({ available: core.availableSources, readiness: core.sourceReadiness() })
  );

  return server;
}
