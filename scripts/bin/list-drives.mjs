#!/usr/bin/env node
// 使い方: node list-drives.mjs [--json]
// OAuth に使った Google アカウントがメンバーになっている共有ドライブの一覧を表示する。
// 研究室の共有ドライブ ID を調べて .env の DRIVE_ID に設定するのに使う。
import { listDrives } from "../lib/gdrive.mjs";
import { config } from "../lib/config.mjs";

async function main() {
  const asJson = process.argv.includes("--json");
  const drives = (await listDrives()).map((d) => ({
    id: d.id,
    name: d.name,
    createdTime: d.createdTime || null,
    current: d.id === config.driveId,
  }));

  if (asJson) {
    process.stdout.write(
      JSON.stringify({ driveId: config.driveId || null, drives }, null, 2) + "\n"
    );
    return;
  }

  process.stdout.write(
    `現在の設定: DRIVE_ID=${config.driveId || "(未設定 — マイドライブ + 全共有ドライブが対象)"}\n\n` +
      `アクセスできる共有ドライブ:\n`
  );
  if (drives.length === 0) {
    process.stdout.write(
      `\n  (なし)\n\n` +
        `共有ドライブが 1 つも見つかりませんでした。研究室の共有ドライブに\n` +
        `OAuth に使った Google アカウントをメンバーとして追加してもらってください。\n` +
        `（「共有フォルダ」は共有ドライブではないので、その場合は DRIVE_FOLDER_IDS を使います）\n`
    );
    return;
  }
  for (const d of drives) {
    process.stdout.write(
      `\n  ${d.name}${d.current ? "  ← 現在の設定" : ""}\n    id: ${d.id}\n`
    );
  }
  process.stdout.write(
    `\n研究室の共有ドライブに絞るには、その id を .env に設定してください:\n` +
      `  DRIVE_ID=<上記の id>\n` +
      `（設定するとその共有ドライブ配下だけを再帰的に検索します）\n`
  );
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
