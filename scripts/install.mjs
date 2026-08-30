#!/usr/bin/env node
// lab-assistant を各アプリに導入するためのインストーラ。
//
//   node scripts/install.mjs install <target>    導入する
//   node scripts/install.mjs update  <target>    最新の内容に入れ替える
//   node scripts/install.mjs uninstall <target>  解除する
//   node scripts/install.mjs status              各アプリの導入状況を表示
//
//   <target>: claude-code | claude-desktop | chatgpt-desktop | codex | chatgpt-web | all
//     claude-code    Claude Code のプラグイン (skills + MCP + hooks)
//     claude-desktop Claude Desktop アプリに MCP サーバーを登録
//     chatgpt-desktop ChatGPT デスクトップのみ (codex CLI を使わない場合)
//     codex          ChatGPT デスクトップ + Codex CLI のプラグイン (skills + MCP)
//     chatgpt-web    ChatGPT Web 用の HTTP コネクタ (要 HTTPS 公開)
//     all            claude-code + codex (ローカルで完結するもの)
//
//   互換: `install.mjs claude-code` のように動詞を省くと install として扱う。
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
  lstatSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, ".."); // lab-assistant/
const MARKETPLACE_ROOT = resolve(PLUGIN_ROOT, ".."); // Agent-Plugins/
const MCP_DIR = join(PLUGIN_ROOT, "mcp-server");
const MCP_STDIO_JS = join(MCP_DIR, "dist", "stdio.js");
const MCP_ENV = join(MCP_DIR, ".env");
const PLUGIN_ENV = join(PLUGIN_ROOT, ".env");
// マーケットプレイス定義。Claude と OpenAI で置き場所が違うが、どちらも
// Agent-Plugins/ (= MARKETPLACE_ROOT) を root として ./lab-assistant を指す。
const CLAUDE_MARKETPLACE = join(MARKETPLACE_ROOT, ".claude-plugin", "marketplace.json");
const OPENAI_MARKETPLACE = join(MARKETPLACE_ROOT, ".agents", "plugins", "marketplace.json");
// ChatGPT デスクトップが読む個人マーケットプレイス。相対パスしか書けない仕様なので
// プラグイン本体へのシンボリックリンクを置く。
const PERSONAL_MARKETPLACE_DIR = join(homedir(), ".agents", "plugins");
const MARKETPLACE_NAME = "vdslab-agent-plugins";
const PERSONAL_MARKETPLACE_NAME = "vdslab-local";
const PLUGIN_NAME = "lab-assistant";

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
  const node = resolveNodePath(); // node をフルパスで固定 (GUI アプリは PATH を持たないため)

  // Claude Code は .mcp.json のバンドル MCP を自動登録するが、Claude Desktop は見ない。
  // 同じ構成になるよう、ここで lab-assistant 本体と一緒に登録する。
  const entries = {
    "lab-assistant": { command: node, args: [MCP_STDIO_JS] },
    ...bundledDesktopServers(node),
  };

  const existing = JSON.stringify(
    Object.fromEntries(Object.keys(entries).map((k) => [k, cfg.mcpServers[k] ?? null]))
  );
  if (existing === JSON.stringify(entries)) {
    log("既に最新の内容で登録済みです。");
    return;
  }
  Object.assign(cfg.mcpServers, entries);

  log("\n登録内容:");
  log(JSON.stringify(entries, null, 2));

  if (DRY) {
    log("\n[dry-run] 書き込みは行いません。");
    return;
  }
  if (existsSync(cfgPath)) backup(cfgPath);
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  log("\n✅ 登録しました。Claude Desktop アプリを完全に再起動してください。");
}

/**
 * .mcp.json (Claude Code 用のバンドル MCP 宣言) を Claude Desktop の設定形式に写す。
 * `${CLAUDE_PLUGIN_ROOT}` を実パスに展開し、`lab-assistant-<name>` として登録する
 * (ユーザーが既に持っている同名サーバーと衝突させないため)。
 */
function bundledDesktopServers(node) {
  const declPath = join(PLUGIN_ROOT, ".mcp.json");
  if (!existsSync(declPath)) return {};
  const decl = readJson(declPath);
  if (!decl) {
    warn(`.mcp.json が JSON として読めないためバンドル MCP は登録しません: ${declPath}`);
    return {};
  }
  const expand = (v) => String(v).replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT);
  const out = {};
  for (const [name, def] of Object.entries(decl)) {
    if (!def?.command) continue; // http/sse 型は Desktop 側の設定が別なのでスキップ
    out[`lab-assistant-${name}`] = {
      command: def.command === "node" ? node : expand(def.command),
      args: (def.args || []).map(expand),
      ...(def.env ? { env: def.env } : {}),
    };
  }
  return out;
}

/** Claude Desktop に登録しうるサーバー名 (本体 + バンドル)。 */
function desktopServerNames() {
  return ["lab-assistant", ...Object.keys(bundledDesktopServers("node"))];
}

function uninstallClaudeDesktop() {
  const cfgPath = claudeDesktopConfigPath();
  const cfg = existsSync(cfgPath) ? readJson(cfgPath) : null;
  const names = desktopServerNames().filter((n) => cfg?.mcpServers?.[n]);
  if (!names.length) {
    log("Claude Desktop には登録されていません。");
    return;
  }
  for (const n of names) delete cfg.mcpServers[n];
  if (DRY) return log(`[dry-run] ${names.join(", ")} を削除します。`);
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
  run("claude", ["plugin", "install", "lab-assistant@vdslab-agent-plugins"]);
  log(
    "\n✅ 完了。実行中の Claude Code セッションでは `/reload-plugins` を実行してください。\n" +
      "   使い方: /lab-assistant:add-event <discord-or-esa-url>"
  );
}

function uninstallClaudeCode() {
  if (!hasClaudeCli()) return warn("`claude` CLI が見つかりません。");
  run("claude", ["plugin", "uninstall", "lab-assistant"]);
}

/** マーケットプレイスを取り込み直してからプラグインを入れ直す。 */
function updateClaudeCode() {
  if (!hasClaudeCli()) return warn("`claude` CLI が見つかりません。");
  log("マーケットプレイスを更新します…");
  run("claude", ["plugin", "marketplace", "update", MARKETPLACE_NAME]);
  log("\nプラグインを入れ直します…");
  run("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
  log(
    "\n✅ 最新の内容に入れ替えました。\n" +
      "   実行中の Claude Code セッションでは /reload-plugins を実行してください。"
  );
}

/** MCP を建て直して登録を書き直す (installClaudeDesktop は冪等)。 */
function updateClaudeDesktop() {
  ensureMcpBuilt();
  installClaudeDesktop();
}

function hasClaudeCli() {
  try {
    execFileSync("claude", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}


// ── codex / ChatGPT デスクトップ ────────────────────────────
function hasCodexCli() {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** OpenAI 形式のマーケットプレイス定義を書き出す (無ければ作る)。 */
function ensureOpenAiMarketplace() {
  const body = {
    name: MARKETPLACE_NAME,
    interface: { displayName: "vdslab Agent Plugins" },
    plugins: [
      {
        name: PLUGIN_NAME,
        // root は Agent-Plugins/ なので、その直下の lab-assistant/ を指す
        source: { source: "local", path: `./${PLUGIN_NAME}` },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  };
  const json = JSON.stringify(body, null, 2) + "\n";
  if (readJson(OPENAI_MARKETPLACE) && readFileSync(OPENAI_MARKETPLACE, "utf8") === json) return;
  if (DRY) return log(`[dry-run] ${OPENAI_MARKETPLACE} を書き出します`);
  mkdirSync(dirname(OPENAI_MARKETPLACE), { recursive: true });
  writeFileSync(OPENAI_MARKETPLACE, json);
  log(`  マーケットプレイス定義: ${OPENAI_MARKETPLACE}`);
}

/**
 * ChatGPT デスクトップが読む個人マーケットプレイス (~/.agents/plugins/)。
 * source.path は root 内の相対パスしか書けないので、本体へのシンボリックリンクを置く。
 *
 * 注意: このマーケットプレイスの **root は ~/.agents/plugins ではなくホーム (~)**。
 * `codex plugin marketplace list` の ROOT 列で確認できる。したがって source.path は
 * ホームからの相対パス (`./.agents/plugins/lab-assistant`) でなければならない。
 * `./lab-assistant` と書くと ~/lab-assistant を探しに行って "not installed" のままになる。
 */
function ensurePersonalMarketplace() {
  const link = join(PERSONAL_MARKETPLACE_DIR, PLUGIN_NAME);
  const file = join(PERSONAL_MARKETPLACE_DIR, "marketplace.json");
  const body = {
    name: PERSONAL_MARKETPLACE_NAME,
    interface: { displayName: "vdslab (local)" },
    plugins: [
      {
        name: PLUGIN_NAME,
        // ホームからの相対パス (root = ~)。上のコメント参照。
        source: { source: "local", path: `./${relative(homedir(), link)}` },
        policy: { installation: "AVAILABLE", authentication: "ON_USE" },
        category: "Productivity",
      },
    ],
  };
  if (DRY) return log(`[dry-run] ${file} と ${link} を用意します`);
  mkdirSync(PERSONAL_MARKETPLACE_DIR, { recursive: true });
  // 既存の marketplace.json に他のプラグインが並んでいたら壊さない
  const cur = readJson(file);
  if (cur && Array.isArray(cur.plugins)) {
    const rest = cur.plugins.filter((x) => x?.name !== PLUGIN_NAME);
    body.plugins = [...rest, ...body.plugins];
    body.name = cur.name || body.name;
  }
  writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  try {
    if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) rmSync(link, { force: true });
  } catch {
    /* 無ければそのまま作る */
  }
  symlinkSync(PLUGIN_ROOT, link);
  log(`  個人マーケットプレイス: ${file}`);
}

function installCodex({ quiet = false } = {}) {
  checkEnv();
  ensureMcpBuilt();
  ensureOpenAiMarketplace();
  ensurePersonalMarketplace();
  if (!hasCodexCli()) {
    warn(
      "`codex` CLI が見つかりません。ChatGPT デスクトップだけで使う場合は問題ありません " +
        "(個人マーケットプレイスは用意済みなので、アプリの Settings → Plugins を確認してください)。"
    );
    return;
  }
  log("\nマーケットプレイスを登録します…");
  run("codex", ["plugin", "marketplace", "add", MARKETPLACE_ROOT]);
  log("\nプラグインをインストールします…");
  run("codex", ["plugin", "add", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
  if (!quiet) {
    log(
      "\n✅ 完了。\n" +
        "   codex plugin list で確認できます。\n" +
        "   ChatGPT デスクトップは再起動後に Settings → Plugins に出ます。\n" +
        "   注意: codex はプラグインを ~/.codex/plugins/cache/ にコピーします。\n" +
        "         リポジトリを編集したら 'node scripts/install.mjs update codex' で入れ直してください。\n" +
        "   注意: 検索スクリプトは外部 API を叩くため、codex 実行時は\n" +
        "         -c 'sandbox_workspace_write.network_access=true' が必要です。"
    );
  }
}

/**
 * codex はインストール時にプラグインをコピーする (スナップショット) ので、
 * 変更を反映するには remove → add で入れ直す必要がある。
 */
function updateCodex() {
  if (!hasCodexCli()) {
    warn("`codex` CLI が見つかりません。個人マーケットプレイスだけ更新します。");
    ensureMcpBuilt();
    ensurePersonalMarketplace();
    return;
  }
  log("古いスナップショットを削除します…");
  run("codex", ["plugin", "remove", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
  installCodex({ quiet: true });
  log("\n✅ 最新の内容に入れ替えました。");
}

function uninstallCodex() {
  if (hasCodexCli()) {
    // プラグイン → マーケットプレイスの順。先に marketplace を消すと plugin を消せなくなる
    run("codex", ["plugin", "remove", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
    run("codex", ["plugin", "marketplace", "remove", MARKETPLACE_NAME]);
  } else {
    warn("`codex` CLI が見つかりません。");
  }
  const link = join(PERSONAL_MARKETPLACE_DIR, PLUGIN_NAME);
  if (DRY) {
    log(`[dry-run] ${link} と codex のキャッシュを削除します`);
    return;
  }
  rmSync(link, { force: true });
  log(`  個人マーケットプレイスのリンクを削除: ${link}`);

  // codex のキャッシュには .env のコピーが含まれる。消え残りがあれば明示的に消す。
  const cache = join(homedir(), ".codex", "plugins", "cache", MARKETPLACE_NAME);
  if (existsSync(cache)) {
    rmSync(cache, { recursive: true, force: true });
    log(`  キャッシュを削除: ${cache}`);
  }
  log(
    existsSync(cache)
      ? `\n⚠ キャッシュが残っています: ${cache} (.env のコピーを含みます)`
      : "\n✅ 解除しました。認証情報のコピーを含むキャッシュも削除済みです。"
  );
}

// ── chatgpt-desktop (ChatGPT デスクトップのみ / codex CLI を使わない) ──
//
// ChatGPT デスクトップは ~/.agents/plugins/marketplace.json だけを読む。
// codex CLI のプラグイン登録 (~/.codex/plugins/cache へのコピー) は不要なので、
// 「ChatGPT デスクトップでは使うが codex CLI では使わない」場合はこちらを使う。

function installChatgptDesktop({ quiet = false } = {}) {
  checkEnv();
  ensureMcpBuilt();
  ensurePersonalMarketplace();
  // ChatGPT デスクトップと codex CLI は ~/.codex/config.toml を共有しており、
  // プラグインの導入状態 ([plugins."name@marketplace"] enabled) もそこに書かれる。
  // アプリの Settings → Plugins から入れても結果は同じ。
  if (hasCodexCli()) {
    log("プラグインを登録します…");
    run("codex", ["plugin", "add", `${PLUGIN_NAME}@${PERSONAL_MARKETPLACE_NAME}`]);
  } else {
    warn(
      "`codex` CLI が見つかりません。マーケットプレイスは用意したので、" +
        "ChatGPT デスクトップの Settings → Plugins から導入してください。"
    );
  }
  if (!quiet) {
    log(
      "\n✅ ChatGPT デスクトップに導入しました。\n" +
        "   アプリを再起動すると Plugins に 'vdslab (local)' の lab-assistant が出ます。\n" +
        "   注意: **コピー型**です。導入時にリポジトリのスナップショットが\n" +
        `         ~/.codex/plugins/cache/${PERSONAL_MARKETPLACE_NAME}/ に作られます。\n` +
        "         リポジトリを編集したら 'update chatgpt-desktop' で入れ直してください。\n" +
        "   注意: スナップショットには .env のコピーが含まれます (解除時に削除されます)。"
    );
  }
}

/** コピー型なので、変更を反映するには remove → add で入れ直す。 */
function updateChatgptDesktop() {
  if (hasCodexCli()) {
    log("古いスナップショットを削除します…");
    run("codex", ["plugin", "remove", `${PLUGIN_NAME}@${PERSONAL_MARKETPLACE_NAME}`]);
  }
  installChatgptDesktop({ quiet: true });
  log("\n✅ 最新の内容に入れ替えました。");
}

function uninstallChatgptDesktop() {
  if (hasCodexCli()) {
    run("codex", ["plugin", "remove", `${PLUGIN_NAME}@${PERSONAL_MARKETPLACE_NAME}`]);
  }
  const link = join(PERSONAL_MARKETPLACE_DIR, PLUGIN_NAME);
  if (DRY) {
    log(`[dry-run] ${link} とスナップショットを削除します`);
    return;
  }
  rmSync(link, { force: true });
  log(`  個人マーケットプレイスのリンクを削除: ${link}`);

  // スナップショットには .env のコピーが含まれるので明示的に消す。
  const cache = join(homedir(), ".codex", "plugins", "cache", PERSONAL_MARKETPLACE_NAME);
  if (existsSync(cache)) {
    rmSync(cache, { recursive: true, force: true });
    log(`  スナップショットを削除: ${cache}`);
  }
  log("\n✅ 解除しました。認証情報のコピーを含むスナップショットも削除済みです。");
}

// ── chatgpt (Web / HTTP コネクタ) ───────────────────────────
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
  log(`     Name : lab-assistant`);
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
  log("lab-assistant 導入状況\n");

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
  const desktopNames = desktopServerNames();
  const present = desktopNames.filter((n) => cfg?.mcpServers?.[n]);
  const inDesktop = present.length === desktopNames.length;
  log(
    `  ${inDesktop ? "✅" : present.length ? "⚠" : "❌"} Claude Desktop アプリ (${cfgPath})` +
      (present.length ? ` — ${present.join(", ")}` : "")
  );

  // claude code
  if (hasClaudeCli()) {
    const r = spawnSync("claude", ["plugin", "list"], { encoding: "utf8" });
    const on = (r.stdout || "").includes("lab-assistant");
    log(`  ${on ? "✅" : "❌"} Claude Code プラグイン`);
  } else {
    log("  —  Claude Code (claude CLI 未検出)");
  }

  // codex / ChatGPT デスクトップ
  if (hasCodexCli()) {
    const r = spawnSync("codex", ["plugin", "list"], { encoding: "utf8" });
    const line = (r.stdout || "")
      .split("\n")
      .find((l) => l.startsWith(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`));
    const on = !!line && line.includes("installed");
    log(`  ${on ? "✅" : "❌"} Codex プラグイン (${PLUGIN_NAME}@${MARKETPLACE_NAME})`);
  } else {
    log("  —  Codex (codex CLI 未検出)");
  }
  // ChatGPT デスクトップ: マーケットプレイスに「並んでいる」ことと、実際に
  // 「導入済み」であることは別。codex plugin list の STATUS が実態なので両方出す。
  const linked = existsSync(join(PERSONAL_MARKETPLACE_DIR, PLUGIN_NAME));
  let desktopState = linked ? "マーケットプレイスのみ (未導入)" : "未設定";
  if (linked) {
    const r = spawnSync("codex", ["plugin", "list"], { encoding: "utf8" });
    const line = (r.stdout || "")
      .split("\n")
      .find((l) => l.includes(`${PLUGIN_NAME}@${PERSONAL_MARKETPLACE_NAME}`));
    if (line) {
      const m = line.match(/installed,\s*enabled|installed|not installed/);
      const ver = line.match(/\b\d+\.\d+\.\d+\b/);
      if (m && m[0] !== "not installed") {
        desktopState = `導入済み・有効${ver ? ` (v${ver[0]})` : ""}`;
      }
    }
  }
  const desktopOk = desktopState.startsWith("導入済み");
  log(
    `  ${desktopOk ? "✅" : linked ? "△" : "❌"} ChatGPT デスクトップ — ${desktopState} ` +
      `(${PERSONAL_MARKETPLACE_DIR})`
  );

  log(
    `\nChatGPT Web のコネクタはローカル設定を持ちません。` +
      `'node scripts/install.mjs install chatgpt-web' を参照。`
  );
}

// ── main ───────────────────────────────────────────────────
const TARGETS = {
  "claude-code": {
    label: "Claude Code プラグイン",
    install: installClaudeCode,
    update: updateClaudeCode,
    uninstall: uninstallClaudeCode,
  },
  "claude-desktop": {
    label: "Claude Desktop アプリ (MCP)",
    install: installClaudeDesktop,
    update: updateClaudeDesktop,
    uninstall: uninstallClaudeDesktop,
  },
  "chatgpt-desktop": {
    label: "ChatGPT デスクトップ (個人マーケットプレイス)",
    install: installChatgptDesktop,
    update: updateChatgptDesktop,
    uninstall: uninstallChatgptDesktop,
  },
  codex: {
    label: "ChatGPT デスクトップ + Codex CLI プラグイン",
    install: installCodex,
    update: updateCodex,
    uninstall: uninstallCodex,
  },
  "chatgpt-web": {
    label: "ChatGPT Web コネクタ (HTTP)",
    install: installChatgpt,
    update: installChatgpt,
    uninstall: () =>
      log("ChatGPT Web コネクタはローカル設定を持ちません。ChatGPT の設定画面から削除してください。"),
  },
};

/** ローカルで完結するもの (all) */
const ALL = ["claude-code", "codex"];

function usage() {
  log(
    [
      "使い方:",
      "  node scripts/install.mjs install   <target>   導入する",
      "  node scripts/install.mjs update    <target>   最新の内容に入れ替える",
      "  node scripts/install.mjs uninstall <target>   解除する",
      "  node scripts/install.mjs status               導入状況を表示",
      "",
      "  <target>:",
      "    claude-code     Claude Code のプラグイン (skills + MCP + hooks)",
      "    claude-desktop  Claude Desktop アプリに MCP サーバーを登録",
      "    chatgpt-desktop ChatGPT デスクトップのみ (codex CLI を使わない場合)",
      "    codex           ChatGPT デスクトップ + Codex CLI のプラグイン (skills + MCP)",
      "    chatgpt-web     ChatGPT Web 用の HTTP コネクタ (要 HTTPS 公開)",
      `    all             ${ALL.join(" + ")}`,
      "",
      "  --dry-run  変更せず内容だけ表示",
      "",
      "例:",
      "  node scripts/install.mjs install all",
      "  node scripts/install.mjs update codex     # リポジトリを編集したあと",
      "  node scripts/install.mjs uninstall codex",
    ].join("\n")
  );
}

function dispatch(verb, name) {
  if (name === "all") {
    for (const t of ALL) {
      log(`\n── ${TARGETS[t].label} ──`);
      TARGETS[t][verb]();
    }
    return;
  }
  const t = TARGETS[name];
  if (!t) {
    die(
      `不明な対象です: ${name || "(未指定)"}\n` +
        `  指定できるのは ${Object.keys(TARGETS).join(" | ")} | all です。`
    );
  }
  t[verb]();
}

const VERBS = new Set(["install", "update", "uninstall"]);
const positional = args.filter((a) => !a.startsWith("--"));

if (positional[0] === "status") {
  status();
} else if (VERBS.has(positional[0])) {
  dispatch(positional[0], positional[1]);
} else if (positional[0] === "chatgpt") {
  // 旧名。HTTP コネクタの準備を指していた
  warn("`chatgpt` は `chatgpt-web` に変わりました (ChatGPT デスクトップ用は `codex`)。");
  installChatgpt();
} else if (positional[0] && TARGETS[positional[0]]) {
  // 動詞省略は install 扱い (旧来の使い方との互換)
  dispatch("install", positional[0]);
} else {
  usage();
  process.exit(positional[0] ? 1 : 0);
}
