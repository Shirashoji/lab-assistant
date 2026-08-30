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
};

// Node 18+ (global fetch) を要求
const major = Number(process.versions.node.split(".")[0]);
if (major < 18) {
  process.stderr.write(
    `[config] Node.js 18 以上が必要です (現在 ${process.versions.node})\n`
  );
  process.exit(1);
}
