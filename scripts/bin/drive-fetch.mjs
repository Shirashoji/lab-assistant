#!/usr/bin/env node
// Drive のファイルをローカルに落として、そのパスを返す (読み取り専用)。
// PDF / スライド / Office など、本文をテキストで抜けない資料を深く読むための入口。
// 落としたファイルは Claude Code の Read でそのまま読める (PDF もネイティブ対応)。
//
// このスクリプトは Drive に GET しか投げない。書き込み・削除・共有変更の API は
// 実装していないので、資料を書き換えられる経路はそもそも存在しない。
//
// 使い方:
//   node drive-fetch.mjs <ファイル ID または Drive URL>
//   node drive-fetch.mjs "https://docs.google.com/presentation/d/xxx/edit" --text
//   node drive-fetch.mjs <id> --out ./tmp --max-mb 100
//   node drive-fetch.mjs <id> --print            # テキスト系ならそのまま標準出力に
//
// 既定は JSON を stdout に出力する (他の bin スクリプトと同じ)。
import { parseFileId, getFileMeta, downloadFile, getFileText, kindOfMime } from "../lib/gdrive.mjs";

/**
 * 落としたファイルを Claude Code の Read がそのまま読めるかどうか。
 * Office 形式 (pptx / docx / xlsx) はバイト列のままなので Read では読めない。
 */
function readHintOf(mimeType) {
  const mt = String(mimeType || "");
  if (
    mt === "application/pdf" ||
    mt.startsWith("text/") ||
    mt.startsWith("image/") ||
    mt === "application/json" ||
    mt === "application/xml"
  ) {
    return { readable: true, hint: "このパスを Read で読んでください。" };
  }
  if (mt.includes("officedocument") || mt.startsWith("application/vnd.ms-")) {
    return {
      readable: false,
      hint:
        "Office 形式なので Read では読めません。pptx / docx / xlsx を扱えるツールで開くか、" +
        "Drive の Web で内容を確認してください。",
    };
  }
  return {
    readable: false,
    hint: "Read で読めるかは形式次第です。読めない場合は Drive の Web で確認してください。",
  };
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--text" || a === "--json" || a === "--print") {
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
  const target = args._.join(" ").trim();
  if (!target) {
    process.stderr.write(
      'ファイル ID か Drive の URL を渡してください。\n' +
        '例: node drive-fetch.mjs "https://drive.google.com/file/d/xxx/view"\n'
    );
    process.exit(2);
  }

  const fileId = parseFileId(target);
  const meta = await getFileMeta(fileId);

  // テキストとして素直に読める形式は、落とさず標準出力に出す方が速い
  if (args.print) {
    const { text, truncated } = await getFileText({
      fileId,
      mimeType: meta.mimeType,
      maxChars: args.chars ? Number(args.chars) : 20000,
    });
    process.stdout.write(text);
    if (truncated) process.stderr.write("\n(長いため途中で打ち切りました。--chars で拡張できます)\n");
    return;
  }

  const result = await downloadFile({
    fileId,
    meta,
    outDir: args.out,
    maxBytes: args["max-mb"] ? Number(args["max-mb"]) * 1024 * 1024 : undefined,
  });
  // 変換後の形式で判定する (スライドは PDF になっているので Read で読める)
  const effectiveMime = result.exportedAs || result.mimeType;
  const { readable, hint } = readHintOf(effectiveMime);
  const payload = { ...result, kind: kindOfMime(result.mimeType), fileId, readable, readHint: hint };

  if (args.text) {
    process.stdout.write(
      `${payload.name}\n` +
        `  種別: ${payload.kind}` +
        (payload.exportedAs ? ` → ${payload.exportedAs} に変換` : "") +
        `\n  サイズ: ${Math.round(payload.bytes / 1024)}KB\n` +
        (payload.modifiedTime ? `  最終更新: ${payload.modifiedTime.slice(0, 10)}\n` : "") +
        (payload.webViewLink ? `  Drive: ${payload.webViewLink}\n` : "") +
        `  保存先: ${payload.path}\n\n` +
        `${payload.readHint}\n`
    );
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  }
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
