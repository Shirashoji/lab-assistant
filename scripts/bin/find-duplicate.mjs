#!/usr/bin/env node
// 使い方: node find-duplicate.mjs --summary "タイトル" --start 2026-09-01T14:00:00+09:00 [--end ...] [--calendar <id>]
// start の前後 26 時間の既存イベントを取得し、重複候補を JSON で出力する。
// 最終的な「同一かどうか」の判断は呼び出し側 (Claude) が意味的に行う前提。
import { findDuplicateCandidates } from "../lib/dedupe.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.summary || !args.start) {
    process.stderr.write("--summary と --start は必須です\n");
    process.exit(2);
  }
  const result = await findDuplicateCandidates({
    summary: args.summary,
    start: args.start,
    end: args.end,
    calendarId: args.calendar,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
