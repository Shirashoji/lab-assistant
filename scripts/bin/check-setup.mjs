#!/usr/bin/env node
// 使い方: node check-setup.mjs [--quiet]
// .env の設定と各 API の疎通を確認する。--quiet は問題があるときだけ 1 行出力 (SessionStart フック用)。
import { config, PLUGIN_ROOT } from "../lib/config.mjs";
import { getUser as esaUser } from "../lib/esa.mjs";
import { listCalendars } from "../lib/gcal.mjs";
import { sourceReadiness } from "../lib/search.mjs";
import { searchFiles } from "../lib/gdrive.mjs";

const quiet = process.argv.includes("--quiet");
const results = [];

function record(name, ok, detail, optional = false) {
  results.push({ name, ok, detail, optional });
}

async function checkDiscord() {
  if (!config.discordToken) return record("Discord トークン", false, "DISCORD_BOT_TOKEN 未設定");
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${config.discordToken}` },
    });
    if (!res.ok) return record("Discord 接続", false, `HTTP ${res.status}`);
    const me = await res.json();
    record("Discord 接続", true, `Bot: ${me.username}#${me.discriminator ?? ""}`);
  } catch (e) {
    record("Discord 接続", false, e.message);
  }
}

async function checkEsa() {
  if (!config.esaToken) return record("esa トークン", false, "ESA_ACCESS_TOKEN 未設定");
  try {
    const me = await esaUser();
    record("esa 接続", true, `User: ${me.screen_name || me.name}`);
  } catch (e) {
    record("esa 接続", false, e.message);
  }
}

async function checkSlack() {
  // Slack は任意機能。未設定なら合否に含めず、下の「横断検索」欄にだけ出す。
  if (!config.slackUserToken) return;
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${config.slackUserToken}` },
    });
    const j = await res.json();
    if (!j.ok) return record("Slack 接続", false, j.error || `HTTP ${res.status}`);
    record("Slack 接続", true, `User: ${j.user} / Team: ${j.team}`);
  } catch (e) {
    record("Slack 接続", false, e.message);
  }
}

async function checkGitHub() {
  // GitHub は任意機能。未設定なら合否に含めず、下の「横断検索」欄にだけ出す。
  if (!config.githubToken) return;
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "lab-assistant",
      },
    });
    const j = await res.json().catch(() => ({}));
    const remaining = res.headers.get("x-ratelimit-remaining") ?? "不明";
    if (!res.ok) {
      return record("GitHub 接続", false, j.message || `HTTP ${res.status}`, true);
    }
    record(
      "GitHub 接続",
      true,
      `User: ${j.login} / レート制限残り: ${remaining}` +
        " (機能ごとの可否は node scripts/bin/check-github-token.mjs)",
      true
    );
  } catch (e) {
    record("GitHub 接続", false, e.message, true);
  }
}

// Drive は任意機能。スコープ追加のため再認証が必要な状態がありうるので、
// 合否 (results) には入れず「横断検索」欄に状態だけ出す。
let driveStatus = null; // { ok:boolean, detail:string }

async function checkDrive() {
  if (!config.googleClientId || !config.googleClientSecret || !config.googleRefreshToken) return;
  try {
    // files.list を 1 件だけ叩いてスコープと疎通を確認する
    const { hits } = await searchFiles({ query: "", limit: 1 });
    // どこを見に行く設定になっているかも出す (DRIVE_ID 未設定だと全ドライブ横断)
    const scope = config.driveId
      ? `共有ドライブ ${config.driveId} に限定`
      : "全ドライブ横断 (DRIVE_ID 未設定 — node scripts/bin/list-drives.mjs で ID を確認)";
    driveStatus = {
      ok: true,
      detail:
        `drive.readonly スコープ OK / ${scope} ` +
        `(サンプル: ${hits[0]?.title || "ファイル 0 件"})`,
    };
  } catch (e) {
    driveStatus = { ok: false, detail: e.message };
  }
}

async function checkGoogle() {
  if (!config.googleClientId || !config.googleClientSecret) {
    return record("Google クライアント", false, "GOOGLE_CLIENT_ID/SECRET 未設定");
  }
  if (!config.googleRefreshToken) {
    return record(
      "Google リフレッシュトークン",
      false,
      "GOOGLE_REFRESH_TOKEN 未設定 (node scripts/bin/auth-google.mjs)"
    );
  }
  try {
    const list = await listCalendars();
    const items = list.items || [];
    const target =
      config.calendarId === "primary"
        ? items.find((c) => c.primary) || null
        : items.find((c) => c.id === config.calendarId) || null;

    if (!target) {
      const label =
        config.calendarId === "primary"
          ? "primary"
          : `${config.calendarId}`;
      record(
        "Google Calendar 接続",
        false,
        `対象カレンダー ${label} が一覧にありません。ID の確認、または OAuth に使った Google アカウントへの共有（予定の変更権限）が必要です。'node scripts/bin/list-calendars.mjs' で確認できます。`
      );
      return;
    }

    const writable = target.accessRole === "owner" || target.accessRole === "writer";
    record(
      "Google Calendar 接続",
      writable,
      `対象カレンダー: ${target.summary}（${target.id} / 権限: ${target.accessRole}）` +
        (writable ? "" : " ← 予定を作成できません。共有設定で「予定の変更」権限を付与してください")
    );
  } catch (e) {
    record("Google Calendar 接続", false, e.message);
  }
}

await Promise.all([
  checkDiscord(),
  checkEsa(),
  checkSlack(),
  checkGoogle(),
  checkGitHub(),
  checkDrive(),
]);

const failed = results.filter((r) => !r.ok && !r.optional);

if (quiet) {
  if (failed.length) {
    process.stderr.write(
      `[lab-assistant] 設定未完了: ${failed
        .map((f) => f.name)
        .join(", ")} — ${PLUGIN_ROOT}/.env を確認 (.env.example 参照)\n`
    );
  }
  process.exit(0);
}

process.stdout.write(`lab-assistant セットアップ確認 (${PLUGIN_ROOT}/.env)\n\n`);
for (const r of results) {
  process.stdout.write(`  ${r.ok ? "✅" : "❌"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}\n`);
}

// 横断検索の準備状況 (任意機能なので合否には含めない)
const readiness = sourceReadiness();
process.stdout.write(
  `\n横断検索 (node scripts/bin/search.mjs — esa / Calendar / Slack / Discord / GitHub / Drive):\n`
);
for (const [src, s] of Object.entries(readiness)) {
  const mark = s.ready ? "✅" : "—";
  process.stdout.write(`  ${mark} ${src}${s.ready ? "" : ` — ${s.reason}`}\n`);
  if (src === "drive" && driveStatus) {
    process.stdout.write(`      ${driveStatus.ok ? "✅" : "⚠"} ${driveStatus.detail}\n`);
  }
}
const calReady = !!(config.googleClientId && config.googleClientSecret && config.googleRefreshToken);
process.stdout.write(
  `\nバンドル MCP (.mcp.json — Claude Code がプラグイン読み込み時に自動登録):\n` +
    `  ${config.esaToken ? "✅" : "—"} esa (plugin:lab-assistant:esa) — ` +
    `${config.esaToken ? "@esaio/esa-mcp-server を .env の ESA_ACCESS_TOKEN で起動" : "ESA_ACCESS_TOKEN 未設定"}\n` +
    `  ${calReady ? "✅" : "—"} seminar-calendar (plugin:lab-assistant:seminar-calendar) — ` +
    `${calReady ? `ゼミの Google Calendar 専用 (${config.calendarId})` : "Google OAuth 未設定"}\n`
);

process.stdout.write(
  failed.length
    ? `\n${failed.length} 件の問題があります。README.md のセットアップ手順を参照してください。\n`
    : `\nすべて OK です。\n`
);
process.exit(failed.length ? 1 : 0);
