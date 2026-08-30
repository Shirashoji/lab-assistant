#!/usr/bin/env -S npx tsx
// stdio トランスポート版。Codex CLI / Claude Desktop / claude mcp add などローカル用途向け。
import "./env.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { makeServer } from "./server.js";

const server = makeServer();
const transport = new StdioServerTransport();
await server.connect(transport);
// stdout は JSON-RPC 専用。ログは stderr へ。
process.stderr.write("lab-assistant MCP server (stdio) 起動\n");
