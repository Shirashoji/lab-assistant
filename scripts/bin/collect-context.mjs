#!/usr/bin/env node
// 使い方: node collect-context.mjs <url> [url2 ...]
// Discord メッセージ URL / esa 記事 URL を受け取り、予定抽出に必要な文脈を JSON で stdout に出力する。
import { collectFromUrls } from "../lib/collect.mjs";

async function main() {
  const urls = process.argv.slice(2).filter(Boolean);
  if (urls.length === 0) {
    process.stderr.write("URL を 1 つ以上渡してください\n");
    process.exit(2);
  }

  const result = await collectFromUrls(urls);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.sources.length === 0) process.exit(1);
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
