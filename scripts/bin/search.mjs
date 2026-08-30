#!/usr/bin/env node
// Google Calendar (ゼミ) / Slack (学科) / Discord / GitHub / Google Drive を横断検索する。
// esa は公式 MCP 側で検索する (スキルが統合する)。
//
// 使い方:
//   node search.mjs "中間報告会"
//   node search.mjs "可視化 D3" --since 2026-04-01 --limit 30
//   node search.mjs "M2 中間報告" --source slack --text
//   node search.mjs "ゼミ リスケ" --source discord --channels 123,456
//   node search.mjs "可視化" --source github --kinds issues,code --text
//   node search.mjs "レイアウト" --source github --kinds discussions --text
//   node search.mjs "d3" --source github --kinds code --enrich-code --text  # code に著者/日付を補完
//   node search.mjs "研究会 スライド" --source drive --limit 10   # Google Drive の資料
//   node search.mjs "週報" --text          # 人間向けの整形出力
//   node search.mjs "発表会" --sort newest # 並び: relevance(既定) | newest | oldest
//
// 既定は JSON を stdout に出力する (他の bin スクリプトと同じ)。
import { searchAll, formatHits, AVAILABLE_SOURCES } from "../lib/search.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text" || a === "--json" || a === "--enrich-code") {
      out[a.slice(2)] = true;
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[key] = val;
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args._.join(" ").trim();
  if (!query) {
    process.stderr.write(
      '検索キーワードを渡してください。例: node search.mjs "中間報告会" --since 2026-04-01\n' +
        `利用可能なソース: ${AVAILABLE_SOURCES.join(", ")}\n`
    );
    process.exit(2);
  }

  const result = await searchAll(query, {
    sources: args.source ? args.source.split(/[,\s]+/).filter(Boolean) : undefined,
    since: args.since,
    until: args.until,
    limit: args.limit ? Number(args.limit) : 40,
    sort: args.sort,
    channels: args.channels ? args.channels.split(/[,\s]+/).filter(Boolean) : undefined,
    calendarId: args.calendar,
    maxChannels: args["max-channels"] ? Number(args["max-channels"]) : undefined,
    maxPagesPerChannel: args.pages ? Number(args.pages) : undefined,
    kinds: args.kinds ? args.kinds.split(/[,\s]+/).filter(Boolean) : undefined,
    enrichCode: !!args["enrich-code"],
  });

  if (args.text) {
    process.stdout.write(formatHits(result) + "\n");
  } else {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
  if (result.hits.length === 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
