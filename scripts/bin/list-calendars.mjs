#!/usr/bin/env node
// 使い方: node list-calendars.mjs [--json]
// OAuth に使った Google アカウントがアクセスできるカレンダー一覧を表示する。
// 研究室カレンダーの ID を調べて .env の GOOGLE_CALENDAR_ID に設定するのに使う。
import { listCalendars } from "../lib/gcal.mjs";
import { config } from "../lib/config.mjs";

async function main() {
  const asJson = process.argv.includes("--json");
  const list = await listCalendars();
  const items = (list.items || []).map((c) => ({
    id: c.id,
    summary: c.summary,
    accessRole: c.accessRole,
    primary: !!c.primary,
    writable: c.accessRole === "owner" || c.accessRole === "writer",
    current: c.id === config.calendarId || (config.calendarId === "primary" && !!c.primary),
  }));

  if (asJson) {
    process.stdout.write(JSON.stringify({ calendarId: config.calendarId, items }, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    `現在の設定: GOOGLE_CALENDAR_ID=${config.calendarId}\n\n` +
      `アクセスできるカレンダー:\n`
  );
  for (const c of items) {
    const marks = [
      c.current ? "← 現在の設定" : "",
      c.primary ? "(primary)" : "",
      c.writable ? "" : "[読み取り専用]",
    ]
      .filter(Boolean)
      .join(" ");
    process.stdout.write(
      `\n  ${c.summary}\n    id: ${c.id}\n    権限: ${c.accessRole} ${marks}\n`
    );
  }
  process.stdout.write(
    `\n研究室カレンダーを使うには、その id を .env に設定してください:\n` +
      `  GOOGLE_CALENDAR_ID=<上記の id>\n` +
      `（一覧に無い場合は、そのカレンダーを OAuth に使った Google アカウントに\n` +
      ` 「予定の変更権限」付きで共有してください）\n`
  );
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
