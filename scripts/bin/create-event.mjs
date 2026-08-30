#!/usr/bin/env node
// 使い方:
//   echo '{"summary":"...","start":"2026-09-01T14:00:00+09:00","end":"..."}' | node create-event.mjs
//   node create-event.mjs --json '{"summary":"..."}'
//
// 入力 JSON のスキーマ:
//   summary     : string  (必須)
//   start       : string  (必須) 時刻付きなら ISO8601 (+09:00 等のオフセット推奨), 終日なら YYYY-MM-DD
//   end         : string  (任意) 省略時は start+1時間 / 終日なら start の翌日
//   allDay      : boolean (任意)
//   location    : string  (任意)
//   description : string  (任意)
//   recurrence  : string[] (任意) 例: ["RRULE:FREQ=WEEKLY;BYDAY=TU"]
//   calendarId  : string  (任意) 省略時は GOOGLE_CALENDAR_ID
import { createEvent } from "../lib/gcal.mjs";

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") out.json = argv[++i];
    else if (argv[i] === "--calendar") out.calendar = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const raw = args.json || (await readStdin());
  if (!raw.trim()) {
    process.stderr.write("イベント JSON を stdin か --json で渡してください\n");
    process.exit(2);
  }
  let e;
  try {
    e = JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`JSON パース失敗: ${err.message}\n`);
    process.exit(2);
  }
  if (!e.summary || !e.start) {
    process.stderr.write("summary と start は必須です\n");
    process.exit(2);
  }

  try {
    if (args.calendar && !e.calendarId) e.calendarId = args.calendar;
    const result = await createEvent(e);
    process.stdout.write(JSON.stringify({ created: true, event: result }, null, 2) + "\n");
  } catch (err) {
    process.stderr.write(`作成失敗: ${err.message}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
