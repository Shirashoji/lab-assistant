#!/usr/bin/env node
// esa 公式 MCP サーバー (@esaio/esa-mcp-server) の起動ラッパ。
//
// プラグインの .env から ESA_ACCESS_TOKEN を読み込んで子プロセスに渡すだけ。
// これにより認証情報を lab-assistant/.env に一元化したまま、Claude Code の
// .mcp.json からは `node scripts/bin/esa-mcp.mjs` を指すだけでよくなる。
//
// stdio はそのまま受け渡す (MCP は stdin/stdout で JSON-RPC する)。
import { spawn } from "node:child_process";
import { config, PLUGIN_ROOT } from "../lib/config.mjs";

const token = config.esaToken;
if (!token) {
  process.stderr.write(
    `ESA_ACCESS_TOKEN が未設定です。${PLUGIN_ROOT}/.env を確認してください (.env.example 参照)。\n`
  );
  process.exit(1);
}

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const child = spawn(npx, ["-y", "@esaio/esa-mcp-server"], {
  stdio: "inherit",
  env: { ...process.env, ESA_ACCESS_TOKEN: token },
});

child.on("error", (e) => {
  process.stderr.write(
    `esa MCP サーバーの起動に失敗しました: ${e.message}\n` +
      `Node.js と npm(npx) が利用可能か確認してください。\n`
  );
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
