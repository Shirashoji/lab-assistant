import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const botRoot = resolve(here, "..");

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = parseEnvFile(resolve(botRoot, ".env"));

function get(key: string, fallback?: string): string | undefined {
  const v = process.env[key] ?? fileEnv[key];
  return v === undefined || v === "" ? fallback : v;
}

function required(key: string): string {
  const v = get(key);
  if (!v) throw new Error(`環境変数 ${key} が未設定です (bot/.env を確認)`);
  return v;
}

const pluginRoot = resolve(get("PLUGIN_ROOT", resolve(botRoot, ".."))!);

export const config = {
  discordToken: required("DISCORD_BOT_TOKEN"),
  allowedGuildIds: (get("ALLOWED_GUILD_IDS", "") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  anthropicApiKey: get("ANTHROPIC_API_KEY"),
  pluginRoot,
};

// Agent SDK / CLI に渡すため、明示的に環境へ反映
if (config.anthropicApiKey) process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
