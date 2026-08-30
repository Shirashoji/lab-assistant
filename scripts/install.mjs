#!/usr/bin/env node
// calendar-agent を各アプリに導入するためのインストーラ。
//
//   node scripts/install.mjs claude-desktop     Claude Desktop アプリに MCP サーバーを登録
//   node scripts/install.mjs claude-code        Claude Code にプラグインを登録
//   node scripts/install.mjs chatgpt [--serve]  ChatGPT カスタムコネクタ用の HTTP サーバーを準備・案内
//   node scripts/install.mjs status             各アプリの導入状況を表示
//   node scripts/install.mjs uninstall <target> claude-desktop | claude-code を解除
//
//   共通オプション: --dry-run (変更せず内容だけ表示)
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  mkdirSync,
  statSync,
  readdirSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, ".."); // Calendar-agent/
const MARKETPLACE_ROOT = resolve(PLUGIN_ROOT, ".."); // Agent-Plugins/
const MCP_DIR = join(PLUGIN_ROOT, "mcp-server");
const MCP_STDIO_JS = join(MCP_DIR, "dist", "stdio.js");
const MCP_ENV = join(MCP_DIR, ".env");
const PLUGIN_ENV = join(PLUGIN_ROOT, ".env");

const args = process.argv.slice(2);
const target = args[0];
const flags = new Set(args.filter((a) => a.startsWith("--")));
const DRY = flags.has("--dry-run");

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn("⚠ ", ...a);
const die = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

function run(cmd, cmdArgs, opts = {}) {
  log(`  $ ${cmd} ${cmdArgs.join(" ")}`);
  if (DRY) return { status: 0, dryRun: true };
  return spawnSync(cmd, cmdArgs, { stdio: "inherit", ...opts });
}

// Claude Desktop / launchd から spawn される node を、安定したフルパスで解決する。
// (harness の sandbox node や nvm shim を避ける)
function resolveNodePath() {
  const bad = (p) => /\/\.hermes\/|local-agent-mode-sessions|\/\.nvm\/.*\/v(?:8|9|1[0-7])\./.test(p);
  const candidates = [];
  try {
    const shell = process.env.SHELL || "/bin/zsh";
    const out = execFileSync(shell, ["-lic", "command -v node"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .pop();
    if (out) candidates.push(out);
  } catch {
    /* ignore */
  }
  candidates.push("/opt/homebrew/bin/node", "/usr/local/bin/node", process.execPath);
  for (const c of candidates) {
    if (!c || bad(c) || !existsSync(c)) continue;
    try {
      const major = Number(
        execFileSync(c, ["-v"], { encoding: "utf8" }).trim().replace(/^v/, "").split(".")[0]
      );
      if (major >= 18) return c;
    } catch {
      /* ignore */
    }
  }
  warn(
    "安定した node が見つからず、現在の実行ファイルを使います。" +
      "Claude Desktop で起動しない場合は設定の command を node のフルパスに直してください。"
  );
  return process.execPath;
}

function claudeDesktopConfigPath() {
  const h = homedir();
  if (platform() === "darwin")
    return join(h, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform() === "win32")
    return join(process.env.APPDATA || join(h, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return join(h, ".config", "Claude", "claude_desktop_config.json");
}

// ── 前提: mcp-server の依存 & ビルド ─────────────────────────
function ensureMcpBuilt() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) die(`Node.js 18 以上が必要です (現在 ${process.versions.node})`);

  if (!existsSync(join(MCP_DIR, "node_modules"))) {
    log("mcp-server の依存をインストールします…");
    const r = run("npm", ["install", "--prefix", MCP_DIR, "--no-audit", "--no-fund"]);
    if (!DRY && r.status !== 0) die("npm install に失敗しました");
  }

  const needBuild =
    !existsSync(MCP_STDIO_JS) ||
    newer(join(MCP_DIR, "src"), MCP_STDIO_JS) ||
    newer(join(PLUGIN_ROOT, "scripts", "lib"), MCP_STDIO_JS);
  if (needBuild) {
    log("mcp-server をビルドします…");
    const r = run("npm", ["run", "build", "--prefix", MCP_DIR]);
    if (!DRY && r.status !== 0) die("ビルドに失敗しました");
  }
  if (!DRY && !existsSync(MCP_STDIO_JS)) die(`ビルド結果が見つかりません: ${MCP_STDIO_JS}`);
}

function newer(srcDir, targetFile) {
  if (!existsSync(targetFile) || !existsSync(srcDir)) return true;
  const t = statSync(targetFile).mtimeMs;
  let latest = 0;
  const walk = (d) => {
    for (const name of safeReaddir(d)) {
      const p = join(d, name);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else latest = Math.max(latest, s.mtimeMs);
    }
  };
  walk(srcDir);
  return latest > t;
}
function safeReaddir(d) {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

function checkEnv() {
  if (!existsSync(PLUGIN_ENV)) {
    warn(
      `${PLUGIN_ENV} がありません。認証情報が未設定です。\n` +
        `  cp ${join(PLUGIN_ROOT, ".env.example")} ${PLUGIN_ENV}\n` +
        `  を実行し README.md に従って埋めてから、'node scripts/bin/check-setup.mjs' で確認してください。`
    );
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function backup(path) {
  const b = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  copyFileSync(path, b);
  log(`  バックアップ: ${b}`);
}

// ── claude-desktop ─────────────────────────────────────────
function installClaudeDesktop() {
  ensureMcpBuilt();
  checkEnv();
  const cfgPath = claudeDesktopConfigPath();
  log(`\nClaude Desktop 設定: ${cfgPath}`);

  let cfg = existsSync(cfgPath) ? readJson(cfgPath) : {};
  if (cfg === null) die(`設定ファイルが JSON として読めません: ${cfgPath}`);
  if (!existsSync(cfgPath)) mkdirSync(dirname(cfgPath), { recursive: true });

  cfg.mcpServers = cfg.mcpServers || {};
  const entry = {
    command: resolveNodePath(), // node をフルパスで固定 (GUI アプリは PATH を持たないため)
    args: [MCP_STDIO_JS],
  };
  const existing = JSON.stringify(cfg.mcpServers["calendar-agent"] || null);
  if (existing === JSON.stringify(entry)) {
    log("既に最新の内容で登録済みです。");
    return;
  }
  cfg.mcpServers["calendar-agent"] = entry;

  log("\n登録内容:");
  log(JSON.stringify({ "calendar-agent": entry }, null, 2));

  if (DRY) {
    log("\n[dry-run] 書き込みは行いません。");
    return;
  }
  if (existsSync(cfgPath)) backup(cfgPath);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  log("\n✅ 登録しました。Claude Desktop アプリを完全に再起動してください。");
}

function uninstallClaudeDesktop() {
  const cfgPath = claudeDesktopConfigPath();
  const cfg = existsSync(cfgPath) ? readJson(cfgPath) : null;
  if (!cfg || !cfg.mcpServers || !cfg.mcpServers["calendar-agent"]) {
    log("Claude Desktop には登録されていません。");
    return;
  }
  delete cfg.mcpServers["calendar-agent"];
  if (DRY) return log("[dry-run] calendar-agent エントリを削除します。");
  backup(cfgPath);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  log("✅ 削除しました。Claude Desktop を再起動してください。");
}

// ── claude-code ────────────────────────────────────────────
function installClaudeCode() {
  checkEnv();
  if (!hasClaudeCli()) die("`claude` CLI が見つかりません。Claude Code をインストールしてください。");
  log("\nマーケットプレイスを登録します…");
  run("claude", ["plugin", "marketplace", "add", MARKETPLACE_ROOT]);
  log("\nプラグインをインストールします…");
  run("claude", ["plugin", "install", "calendar-agent@vdslab-agent-plugins"]);
  log(
    "\n✅ 完了。実行中の Claude Code セッションでは `/reload-plugins` を実行してください。\n" +
      "   使い方: /calendar-agent:add-event <discord-or-esa-url>"
  );
}

function uninstallClaudeCode() {
  if (!hasClaudeCli()) return warn("`claude` CLI が見つかりません。");
  run("claude", ["plugin", "uninstall", "calendar-agent"]);
}

function hasClaudeCli() {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ── chatgpt ────────────────────────────────────────────────
function ensureAuthToken() {
  let lines = existsSync(MCP_ENV) ? readFileSync(MCP_ENV, "utf8").split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.startsWith("MCP_AUTH_TOKEN="));
  const current = idx >= 0 ? lines[idx].slice("MCP_AUTH_TOKEN=".length).trim() : "";
  if (current) return current;

  const token = randomBytes(32).toString("hex");
  if (DRY) {
    log(`[dry-run] MCP_AUTH_TOKEN を生成して ${MCP_ENV} に書き込みます。`);
    return token;
  }
  if (idx >= 0) lines[idx] = `MCP_AUTH_TOKEN=${token}`;
  else {
    if (!existsSync(MCP_ENV) && existsSync(join(MCP_DIR, ".env.example"))) {
      lines = readFileSync(join(MCP_DIR, ".env.example"), "utf8").split(/\r?\n/);
      const j = lines.findIndex((l) => l.startsWith("MCP_AUTH_TOKEN="));
      if (j >= 0) lines[j] = `MCP_AUTH_TOKEN=${token}`;
      else lines.push(`MCP_AUTH_TOKEN=${token}`);
    } else {
      lines.push(`MCP_AUTH_TOKEN=${token}`);
    }
  }
  writeFileSync(MCP_ENV, lines.join("\n"));
  log(`  MCP_AUTH_TOKEN を生成し ${MCP_ENV} に保存しました。`);
  return token;
}

function readPort() {
  for (const f of [MCP_ENV, PLUGIN_ENV]) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^PORT=(\d+)/m);
    if (m) return Number(m[1]);
  }
  return 8787;
}

function installChatgpt() {
  ensureMcpBuilt();
  checkEnv();
  const token = ensureAuthToken();
  const port = readPort();
  const hasCloudflared = which("cloudflared");

  log(`\n── ChatGPT カスタムコネクタの準備 ──────────────────────────`);
  log(`\n1) MCP サーバー (HTTP) を起動:`);
  log(`   node ${join(MCP_DIR, "dist", "http.js")}`);
  log(`   （または: npm run start:http --prefix ${MCP_DIR}）`);
  log(`   → http://localhost:${port}/mcp  [Bearer 認証あり]`);

  log(`\n2) 公開 HTTPS にする (ChatGPT は localhost に到達できません):`);
  if (hasCloudflared) {
    log(`   cloudflared tunnel --url http://localhost:${port}`);
    log(`   表示された https://xxxx.trycloudflare.com が公開 URL。末尾に /mcp を付けます。`);
  } else {
    log(`   cloudflared 未インストール。'brew install cloudflared' 後に:`);
    log(`   cloudflared tunnel --url http://localhost:${port}`);
    log(`   （ngrok など他のトンネルでも可）`);
  }

  log(`\n3) ChatGPT (Web またはアプリ / 同じアカウント設定):`);
  log(`   Settings → Apps → Advanced settings → Developer mode を ON`);
  log(`   → カスタムコネクタを追加:`);
  log(`     Name : calendar-agent`);
  log(`     URL  : https://<トンネルのドメイン>/mcp`);
  log(`     Auth : API key / Bearer  →  ${DRY ? "<生成されるトークン>" : token}`);

  log(`\n4) チャットで Discord / esa の URL を投げれば`);
  log(`   collect_context → find_duplicate_events → create_event が実行されます。`);

  if (flags.has("--serve")) {
    log(`\n──『--serve』: HTTP サーバーをこのプロセスで起動します (Ctrl+C で停止) ──\n`);
    if (DRY) return;
    const r = spawnSync(process.execPath, [join(MCP_DIR, "dist", "http.js")], {
      stdio: "inherit",
      env: { ...process.env, PORT: String(port) },
    });
    process.exit(r.status ?? 0);
  } else {
    log(`\nヒント: 'node scripts/install.mjs chatgpt --serve' でこの案内の後にサーバーを起動できます。`);
  }
}

function which(bin) {
  const r = spawnSync(platform() === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
  return r.status === 0;
}

// ── status ─────────────────────────────────────────────────
function status() {
  log("calendar-agent 導入状況\n");

  // .env
  log(`  ${existsSync(PLUGIN_ENV) ? "✅" : "❌"} 認証設定 (${PLUGIN_ENV})`);

  // mcp-server
  const built = existsSync(MCP_STDIO_JS);
  const deps = existsSync(join(MCP_DIR, "node_modules"));
  log(`  ${deps ? "✅" : "❌"} mcp-server 依存インストール`);
  log(`  ${built ? "✅" : "❌"} mcp-server ビルド (dist/)`);
  const tokenSet =
    existsSync(MCP_ENV) && /^MCP_AUTH_TOKEN=.+/m.test(readFileSync(MCP_ENV, "utf8"));
  log(`  ${tokenSet ? "✅" : "—"} MCP_AUTH_TOKEN (ChatGPT 用 / 任意)`);

  // claude desktop
  const cfgPath = claudeDesktopConfigPath();
  const cfg = existsSync(cfgPath) ? readJson(cfgPath) : null;
  const inDesktop = !!cfg?.mcpServers?.["calendar-agent"];
  log(`  ${inDesktop ? "✅" : "❌"} Claude Desktop アプリ (${cfgPath})`);

  // claude code
  if (hasClaudeCli()) {
    const r = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" });
    const on = (r.stdout || "").includes("calendar-agent");
    log(`  ${on ? "✅" : "❌"} Claude Code プラグイン`);
  } else {
    log("  —  Claude Code (claude CLI 未検出)");
  }

  log(`\nChatGPT はローカル設定を持ちません。'node scripts/install.mjs chatgpt' を参照。`);
}

// ── main ───────────────────────────────────────────────────
function usage() {
  log(
    [
      "使い方:",
      "  node scripts/install.mjs claude-desktop      Claude Desktop アプリに MCP を登録",
      "  node scripts/install.mjs claude-code         Claude Code にプラグインを登録",
      "  node scripts/install.mjs chatgpt [--serve]   ChatGPT コネクタ用 HTTP サーバーの準備・案内",
      "  node scripts/install.mjs status              導入状況を表示",
      "  node scripts/install.mjs uninstall <target>  claude-desktop | claude-code を解除",
      "",
      "  --dry-run  変更せず内容だけ表示",
    ].join("\n")
  );
}

switch (target) {
  case "claude-desktop":
    installClaudeDesktop();
    break;
  case "claude-code":
    installClaudeCode();
    break;
  case "chatgpt":
    installChatgpt();
    break;
  case "status":
    status();
    break;
  case "uninstall": {
    const t = args[1];
    if (t === "claude-desktop") uninstallClaudeDesktop();
    else if (t === "claude-code") uninstallClaudeCode();
    else die("uninstall の対象は claude-desktop または claude-code です");
    break;
  }
  default:
    usage();
    process.exit(target ? 1 : 0);
}
