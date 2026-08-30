#!/usr/bin/env node
// あるトピックに詳しい人を、横断検索のヒットから推定する。
//
// Calendar (ゼミ) / Slack (学科) / Discord をコードで検索し、投稿者ごとに畳み込んで
// 「詳しそうな人」を根拠 (投稿・記事のリンク) 付きで返す。
// esa / GitHub / Drive など公式 MCP 側で検索したヒットは --extra-hits で混ぜられる。
//
// 使い方:
//   node find-expert.mjs "MCP"
//   node find-expert.mjs "トーラス" --since 2024-04-01 --top 5 --text
//   node find-expert.mjs "根付き木" --source discord,slack --limit 80
//   esa MCP の結果を混ぜる (共通ヒット形の JSON 配列を標準入力から):
//     cat esa-hits.json | node find-expert.mjs "MCP" --extra-hits - --text
//   GitHub 連携などの Bot 投稿も含める:
//     node find-expert.mjs "MCP" --include-bots
//   同一人物の名寄せ:
//     node find-expert.mjs "可視化" --alias "たくま=takuma,shirashoji=takuma"
//
// 既定は JSON を stdout に出力する (他の bin スクリプトと同じ)。
import { readFileSync } from "node:fs";
import { searchAll, AVAILABLE_SOURCES } from "../lib/search.mjs";
import { aggregateExperts, formatExperts, looksLikeRawId } from "../lib/experts.mjs";
import { resolveUserNames } from "../lib/slack.mjs";
import { config } from "../lib/config.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text" || a === "--json" || a === "--no-resolve" || a === "--include-bots") {
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

/** "a=b, c=b" → { a: "b", c: "b" } */
function parseAliases(s) {
  const out = {};
  for (const pair of String(s || "").split(/[,\n]+/)) {
    const [from, to] = pair.split("=").map((x) => (x || "").trim());
    if (from && to) out[from] = to;
  }
  return out;
}

/** --extra-hits で渡された JSON (配列 or {hits:[...]}) を読む。"-" は標準入力。 */
function readExtraHits(path) {
  const raw = path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--extra-hits の JSON を解析できません: ${e.message}`);
  }
  const hits = Array.isArray(parsed) ? parsed : parsed.hits;
  if (!Array.isArray(hits)) {
    throw new Error("--extra-hits は ヒットの配列 または {\"hits\": [...]} である必要があります");
  }
  return hits.map((h) => ({ source: h.source || "extra", ...h }));
}

/**
 * Slack のヒットで投稿者が生の ID (U01ABCDEF) のままのものを表示名に直す。
 * users:read スコープが無ければ黙って ID のままにする。
 */
async function resolveSlackNames(hits, warnings) {
  if (!config.slackUserToken) return;
  const ids = hits
    .filter((h) => h.source === "slack" && h.author && looksLikeRawId(h.author))
    .map((h) => h.author);
  if (!ids.length) return;
  const names = await resolveUserNames(ids);
  const resolved = Object.keys(names).length;
  for (const h of hits) {
    if (h.source === "slack" && names[h.author]) h.author = names[h.author];
  }
  if (resolved < new Set(ids).size) {
    warnings.push(
      "[slack] 一部のユーザー ID を表示名に解決できませんでした (users:read スコープ不足の可能性)"
    );
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const query = args._.join(" ").trim();
  if (!query) {
    process.stderr.write(
      'トピックを渡してください。例: node find-expert.mjs "MCP" --since 2025-01-01 --text\n' +
        `コードで検索できるソース: ${AVAILABLE_SOURCES.join(", ")}\n` +
        "(esa / その他 MCP 側の結果は --extra-hits で混ぜてください)\n"
    );
    process.exit(2);
  }

  const result = await searchAll(query, {
    sources: args.source ? args.source.split(/[,\s]+/).filter(Boolean) : undefined,
    since: args.since,
    until: args.until,
    // 人物ごとに畳み込むので、検索そのものは広めに取る
    limit: args.limit ? Number(args.limit) : 120,
    sort: "newest",
    channels: args.channels ? args.channels.split(/[,\s]+/).filter(Boolean) : undefined,
    calendarId: args.calendar,
    maxChannels: args["max-channels"] ? Number(args["max-channels"]) : undefined,
    maxPagesPerChannel: args.pages ? Number(args.pages) : undefined,
  });

  const hits = [...result.hits];
  if (args["extra-hits"]) hits.push(...readExtraHits(args["extra-hits"]));

  if (!args["no-resolve"]) {
    try {
      await resolveSlackNames(hits, result.warnings);
    } catch (e) {
      result.warnings.push(`[slack] 表示名の解決に失敗: ${e.message}`);
    }
  }

  const experts = aggregateExperts(hits, {
    query,
    top: args.top ? Number(args.top) : 8,
    minHits: args["min-hits"] ? Number(args["min-hits"]) : 1,
    evidencePerExpert: args.evidence ? Number(args.evidence) : 5,
    halfLifeDays: args["half-life"] ? Number(args["half-life"]) : undefined,
    aliases: args.alias ? parseAliases(args.alias) : undefined,
    includeBots: !!args["include-bots"],
  });

  // 検索そのもののカバレッジも一緒に返す (回答に「見た範囲」を書けるように)
  const payload = {
    ...experts,
    window: result.window,
    searched: result.searched,
    skipped: result.skipped,
    coverage: result.coverage,
    countBySource: experts.countBySource,
    warnings: result.warnings,
  };

  if (args.text) {
    process.stdout.write(formatExperts(payload) + "\n");
    if (payload.searched?.length) {
      process.stdout.write(
        `\n見たソース: ${payload.searched.join(", ")}` +
          (payload.skipped?.length
            ? ` / スキップ: ${payload.skipped.map((s) => `${s.source} (${s.reason})`).join(", ")}`
            : "") +
          `\n期間: ${payload.window.since || "指定なし"} 〜 ${payload.window.until || "今日"}\n`
      );
    }
    if (payload.warnings?.length) {
      process.stdout.write("\n⚠ 警告:\n" + payload.warnings.map((w) => `  - ${w}`).join("\n") + "\n");
    }
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  }
  if (payload.experts.length === 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
