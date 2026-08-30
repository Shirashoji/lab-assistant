// 依存ゼロの最小 MCP サーバー (stdio / 改行区切り JSON-RPC 2.0)。
// @modelcontextprotocol/sdk を使わずに済むよう、必要な範囲だけ実装している。
//
// 使い方:
//   import { runMcpServer } from "../lib/mcp-stdio.mjs";
//   runMcpServer({
//     name: "seminar-calendar", version: "0.1.0",
//     tools: [
//       { name: "list_events", description: "...", inputSchema: {...},
//         handler: async (args) => ({ ... }) },  // 返り値は JSON 化して text で返す
//     ],
//   });
//
// stdout は JSON-RPC 専用。ログは必ず stderr へ。

import { createInterface } from "node:readline";

const PROTOCOL_VERSION = "2024-11-05";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function ok(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function err(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

export function runMcpServer({ name, version = "0.1.0", tools = [] }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const toolList = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema: inputSchema || { type: "object", properties: {} },
  }));

  let pending = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    pending++;
    handleLine(line).finally(() => {
      pending--;
      maybeExit();
    });
  });
  rl.on("close", () => {
    closed = true;
    maybeExit();
  });
  process.stderr.write(`${name} MCP server (stdio) 起動\n`);

  async function handleLine(line) {
    const raw = line.trim();
    if (!raw) return;
    let req;
    try {
      req = JSON.parse(raw);
    } catch {
      return; // フレーミング違反は黙って捨てる
    }
    const { id, method, params } = req;
    const isNotification = id === undefined || id === null;

    try {
      if (method === "initialize") {
        return ok(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name, version },
        });
      }
      if (method === "notifications/initialized" || method === "notifications/cancelled") {
        return; // 通知には応答しない
      }
      if (method === "ping") return ok(id, {});
      if (method === "tools/list") return ok(id, { tools: toolList });
      if (method === "tools/call") {
        const tool = byName.get(params?.name);
        if (!tool) return err(id, -32602, `unknown tool: ${params?.name}`);
        try {
          const result = await tool.handler(params.arguments || {});
          const text =
            typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return ok(id, { content: [{ type: "text", text }] });
        } catch (e) {
          return ok(id, {
            content: [{ type: "text", text: `エラー: ${e.message}` }],
            isError: true,
          });
        }
      }
      if (isNotification) return;
      return err(id, -32601, `method not found: ${method}`);
    } catch (e) {
      if (!isNotification) err(id, -32603, e.message);
    }
  }
}
