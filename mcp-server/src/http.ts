// Streamable HTTP トランスポート版。ChatGPT のカスタムコネクタなどリモート用途向け。
// ChatGPT からは localhost に到達できないため、cloudflared / ngrok 等で公開 HTTPS にすること。
import "./env.js";
import express, { type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { makeServer } from "./server.js";

const PORT = Number(process.env.PORT || process.env.MCP_HTTP_PORT || 8787);
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN; // 設定時のみ Bearer 認証を要求
const MCP_PATH = "/mcp";

const app = express();
app.use(express.json({ limit: "4mb" }));

// 任意の Bearer 認証
app.use(MCP_PATH, (req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${AUTH_TOKEN}`) return next();
  res
    .status(401)
    .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
});

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post(MCP_PATH, async (req: Request, res: Response) => {
  try {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport | undefined = sid ? transports[sid] : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: session が無効です" },
          id: null,
        });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      await makeServer().connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: (err as Error).message },
        id: null,
      });
    }
  }
});

async function replaySession(req: Request, res: Response) {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const transport = sid ? transports[sid] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get(MCP_PATH, replaySession);
app.delete(MCP_PATH, replaySession);

app.get("/", (_req, res) => {
  res.json({ name: "calendar-agent-mcp", transport: "streamable-http", endpoint: MCP_PATH });
});

app.listen(PORT, () => {
  console.error(
    `calendar-agent MCP server (http) → http://localhost:${PORT}${MCP_PATH}` +
      (AUTH_TOKEN ? " [Bearer 認証あり]" : " [認証なし]")
  );
});
