// 設定の読み込み。依存ゼロ。
// 優先順位: 実行環境の環境変数 > ${CLAUDE_PLUGIN_ROOT}/.env
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// scripts/lib/ から見たプラグインルート
export const PLUGIN_ROOT =
  process.env.CLAUDE_PLUGIN_ROOT
    ? resolve(process.env.CLAUDE_PLUGIN_ROOT)
    : resolve(__dirname, "..", "..");

/** きわめて素朴な .env パーサ (KEY=VALUE, # コメント, 前後空白除去, 任意のクォート除去) */
function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

let fileEnv = {};
const envPath = join(PLUGIN_ROOT, ".env");
if (existsSync(envPath)) {
  try {
    fileEnv = parseEnv(readFileSync(envPath, "utf8"));
  } catch (e) {
    process.stderr.write(`[config] .env 読み込み失敗: ${e.message}\n`);
  }
}

/** 環境変数を優先し、なければ .env の値、なければ fallback */
export function env(key, fallback = undefined) {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === "" ? fallback : v;
}

export function requireEnv(key) {
  const v = env(key);
  if (!v) {
    throw new Error(
      `環境変数 ${key} が未設定です。${envPath} を確認してください (.env.example 参照)。`
    );
  }
  return v;
}

/** "a, b ,c" → ["a","b","c"] (空要素除去)。未設定は [] */
function list(key) {
  return (env(key, "") || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  get discordToken() {
    return env("DISCORD_BOT_TOKEN");
  },
  get esaToken() {
    return env("ESA_ACCESS_TOKEN");
  },
  get esaDefaultTeam() {
    return env("ESA_DEFAULT_TEAM");
  },
  /** 自前アプリ lab-assistant-search の User OAuth Token (xoxp-)。search.messages 用。 */
  get slackUserToken() {
    return env("SLACK_USER_TOKEN");
  },
  get googleClientId() {
    return env("GOOGLE_CLIENT_ID");
  },
  get googleClientSecret() {
    return env("GOOGLE_CLIENT_SECRET");
  },
  get googleRefreshToken() {
    return env("GOOGLE_REFRESH_TOKEN");
  },
  get calendarId() {
    return env("GOOGLE_CALENDAR_ID", "primary");
  },
  get timezone() {
    return env("TIMEZONE", "Asia/Tokyo");
  },
  get oauthRedirectPort() {
    return Number(env("OAUTH_REDIRECT_PORT", "4779"));
  },

  // ── 横断検索 (Phase 1) ───────────────────────────────────
  /** Discord 横断検索の対象ギルド ID。未設定なら Bot が参加する全ギルドを対象にする。 */
  get discordGuildIds() {
    return list("DISCORD_GUILD_IDS");
  },
  /** 検索対象チャンネルを絞る場合の許可リスト (省略時は対象ギルドの全テキストチャンネル)。 */
  get discordSearchChannelIds() {
    return list("DISCORD_SEARCH_CHANNEL_IDS");
  },
  /** 1 チャンネルあたり遡って取得するページ数 (100 件/ページ)。 */
  get searchMaxPagesPerChannel() {
    const n = Number(env("SEARCH_MAX_PAGES_PER_CHANNEL", "3"));
    return Number.isFinite(n) && n > 0 ? Math.min(n, 20) : 3;
  },

  // ── GitHub (Phase 4) ─────────────────────────────────────
  /** GitHub REST API 用の Personal Access Token (classic でも fine-grained でも可)。 */
  get githubToken() {
    return env("GITHUB_TOKEN");
  },
  /** 検索対象の org (カンマ区切り)。未設定なら GitHub 全体を検索する。 */
  get githubOrgs() {
    return list("GITHUB_ORGS");
  },
  /** 検索対象を特定リポジトリに絞る場合 (owner/name のカンマ区切り)。 */
  get githubRepos() {
    return list("GITHUB_REPOS");
  },

  // ── Google Drive (Phase 4) ───────────────────────────────
  /**
   * 研究室の共有ドライブ ID。設定するとその共有ドライブ配下だけを (再帰的に) 検索する。
   * 未設定ならアクセスできる範囲全体 (マイドライブ + 全共有ドライブ) が対象。
   * ID は `node scripts/bin/list-drives.mjs` で調べられる。
   */
  get driveId() {
    return env("DRIVE_ID");
  },
  /** さらに絞るフォルダ ID (カンマ区切り)。直下のファイルのみ (再帰しない)。 */
  get driveFolderIds() {
    return list("DRIVE_FOLDER_IDS");
  },
  /** 検索対象の MIME タイプを絞る場合 (カンマ区切り)。 */
  get driveMimeTypes() {
    return list("DRIVE_MIME_TYPES");
  },
};

// Node 18+ (global fetch) を要求
const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
  process.stderr.write(
    `[config] Node.js 18 以上が必要です (現在 ${process.versions.node})\n`
  );
  process.exit(1);
}
