// Google Drive API v3 (REST) の薄いラッパ + 全文検索。依存ゼロ。
//
// 認証は Calendar と同じ OAuth (GOOGLE_CLIENT_ID / SECRET / GOOGLE_REFRESH_TOKEN) を
// そのまま再利用する (gcal.mjs の getAccessToken)。ただし Drive を読むには
// `drive.readonly` スコープが要る。既存のリフレッシュトークンは Calendar スコープしか
// 持っていないので、その場合は `node scripts/bin/auth-google.mjs` を再実行して
// トークンを取り直す必要がある (403 のときに日本語でその旨を投げる)。
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getAccessToken } from "./gcal.mjs";
import { config } from "./config.mjs";

const DRIVE_API = "https://www.googleapis.com/drive/v3";

/** files.list で取得するフィールド。 */
const FILE_FIELDS =
  "nextPageToken, files(id,name,mimeType,webViewLink,modifiedTime,createdTime," +
  "owners(displayName,emailAddress),lastModifyingUser(displayName,emailAddress)," +
  "parents,description,size)";

/** ページングの上限 (1 ページ最大 100 件)。 */
const MAX_PAGES = 5;

/** mimeType → 日本語のわかりやすい種別。未知のものは mimeType をそのまま使う。 */
const KIND_BY_MIME = {
  "application/vnd.google-apps.document": "ドキュメント",
  "application/vnd.google-apps.spreadsheet": "スプレッドシート",
  "application/vnd.google-apps.presentation": "スライド",
  "application/vnd.google-apps.folder": "フォルダ",
  "application/vnd.google-apps.form": "フォーム",
  "application/vnd.google-apps.drawing": "図形描画",
  "application/pdf": "PDF",
};

/** @param {string} mimeType */
export function kindOfMime(mimeType) {
  return KIND_BY_MIME[mimeType] || mimeType || "不明";
}

/**
 * Drive のクエリ文字列に値を埋め込む前のエスケープ。
 * シングルクォートとバックスラッシュを潰さないとクエリを壊せてしまう。
 */
function escapeQueryValue(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** "2026-04-01" などを RFC3339 に正規化する。 */
function toISO(value, label) {
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new Error(`${label} の日付を解釈できません: ${value}`);
  }
  return new Date(t).toISOString();
}

/** files.list の `q` を組み立てる。 */
function buildQuery({ query, groups, since, until, folderIds, mimeTypes }) {
  const parts = [];
  // 関連語グループがあれば「グループ内 OR / グループ間 AND」に展開する。
  // Drive は OR/AND を式で書けるので、
  //   (fullText contains 'ゼミ' or fullText contains 'seminar') and (fullText contains '日程')
  // の形にする。
  if (groups?.length) {
    for (const g of groups) {
      const vs = (g.variants?.length ? g.variants : [g.base]).slice(0, 5).filter(Boolean);
      if (!vs.length) continue;
      const ors = vs.map((v) => `fullText contains '${escapeQueryValue(v)}'`);
      parts.push(ors.length === 1 ? ors[0] : `(${ors.join(" or ")})`);
    }
  } else {
    const q = String(query || "").trim();
    if (q) parts.push(`fullText contains '${escapeQueryValue(q)}'`);
  }
  parts.push("trashed = false");
  if (since) parts.push(`modifiedTime > '${escapeQueryValue(toISO(since, "since"))}'`);
  if (until) parts.push(`modifiedTime < '${escapeQueryValue(toISO(until, "until"))}'`);
  if (folderIds?.length) {
    parts.push(
      "(" + folderIds.map((id) => `'${escapeQueryValue(id)}' in parents`).join(" or ") + ")"
    );
  }
  if (mimeTypes?.length) {
    parts.push(
      "(" + mimeTypes.map((m) => `mimeType = '${escapeQueryValue(m)}'`).join(" or ") + ")"
    );
  }
  return parts.join(" and ");
}

/** Drive API のエラーレスポンスを日本語の Error に変換する。 */
function driveError(status, json, raw) {
  const err = json?.error || {};
  const message = err.message || String(raw || "").slice(0, 300);
  const reasons = (err.errors || []).map((e) => e.reason || "").join(",");
  const hay = `${reasons} ${err.status || ""} ${message}`.toLowerCase();

  if (
    status === 403 &&
    (hay.includes("insufficientpermissions") ||
      hay.includes("insufficient authentication scopes") ||
      hay.includes("access_token_scope_insufficient"))
  ) {
    return new Error(
      "Drive のスコープが未許可です。`node scripts/bin/auth-google.mjs` を再実行して" +
        "リフレッシュトークンを取り直してください (drive.readonly スコープが必要です)。"
    );
  }
  if (status === 403 && (hay.includes("accessnotconfigured") || hay.includes("service_disabled"))) {
    return new Error(
      "Google Cloud プロジェクトで Drive API が有効になっていません。" +
        "Cloud Console の「API とサービス」から Google Drive API を有効化してください。"
    );
  }
  if (
    status === 429 ||
    (status === 403 &&
      (hay.includes("ratelimitexceeded") ||
        hay.includes("userratelimitexceeded") ||
        hay.includes("quotaexceeded")))
  ) {
    return new Error(
      `Drive API のレート制限に達しました (${status})。少し待ってから再実行するか、` +
        "--limit を小さくして検索範囲を狭めてください。"
    );
  }
  if (status === 404 && hay.includes("notfound")) {
    return new Error(
      "Drive の対象が見つかりません (404)。.env の DRIVE_ID / DRIVE_FOLDER_IDS が正しいか、" +
        "OAuth に使った Google アカウントがその共有ドライブのメンバーかを確認してください " +
        "(ID は `node scripts/bin/list-drives.mjs` で調べられます)。"
    );
  }
  if (status === 401) {
    return new Error(
      "Google の認証に失敗しました (401)。GOOGLE_REFRESH_TOKEN が失効している可能性があります。" +
        "`node scripts/bin/auth-google.mjs` を再実行してください。"
    );
  }
  return new Error(`Drive API ${status}: ${message}`);
}

/** Drive API を叩いて Response をそのまま返す (本文取得でも使う)。 */
async function driveRequest(path, params) {
  const token = await getAccessToken();
  const qs = params ? `?${params}` : "";
  const res = await fetch(`${DRIVE_API}${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => "");
    let json = {};
    try {
      json = JSON.parse(raw);
    } catch {
      /* JSON でなければ raw をそのまま使う */
    }
    throw driveError(res.status, json, raw);
  }
  return res;
}

async function driveFetchJson(path, params) {
  const res = await driveRequest(path, params);
  return res.json();
}

/** Drive のファイル 1 件を共通ヒット形に変換する。 */
function fileToHit(f) {
  const kind = kindOfMime(f.mimeType);
  const modified = f.modifiedTime ? f.modifiedTime.slice(0, 10) : "不明";
  const editor = f.lastModifyingUser?.displayName || f.owners?.[0]?.displayName || null;
  const description = (f.description || "").replace(/\s+/g, " ").trim();
  return {
    source: "drive",
    title: f.name || "(名前なし)",
    url: f.webViewLink || null,
    snippet:
      description ||
      `${kind} ・ 最終更新: ${modified}` + (editor ? ` ・ 更新者: ${editor}` : ""),
    author: editor,
    timestamp: f.modifiedTime || null,
    extra: {
      fileId: f.id || null,
      mimeType: f.mimeType || null,
      kind,
      owners: (f.owners || []).map((o) => ({
        name: o.displayName || null,
        email: o.emailAddress || null,
      })),
      createdTime: f.createdTime || null,
      size: f.size ? Number(f.size) : null,
      parents: f.parents || [],
    },
  };
}

/**
 * Google Drive をキーワード (全文) + 期間で検索する。
 * `driveId` (既定は .env の DRIVE_ID) があれば研究室の共有ドライブ 1 つだけを対象にし、
 * 無ければ共有ドライブ込みでアクセスできる範囲全体 (`corpora=allDrives`) を対象にする。
 * @param {{query:string, since?:string, until?:string, limit?:number, driveId?:string,
 *          folderIds?:string[], mimeTypes?:string[], includeShared?:boolean}} opts
 * @returns {Promise<{hits:object[], warnings:string[], total:number, hasMore:boolean}>}
 */
export async function searchFiles(opts = {}) {
  const {
    query,
    since,
    until,
    folderIds,
    mimeTypes,
    includeShared = true,
    driveId = config.driveId,
  } = opts;
  const limit = Math.max(1, Number(opts.limit) || 20);
  const q = buildQuery({ query, groups: opts.groups, since, until, folderIds, mimeTypes });
  const warnings = [];
  const files = [];
  let pageToken = null;
  let hasMore = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      q,
      fields: FILE_FIELDS,
      pageSize: String(Math.min(Math.max(limit - files.length, 1), 100)),
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
      // driveId があれば研究室の共有ドライブ 1 つに絞る (配下のフォルダも再帰的に対象)。
      // 無ければ従来どおり共有ドライブ込みで横断する
      // (drive / allDrives では orderBy が使えないので後で自前ソート)
      corpora: driveId ? "drive" : includeShared ? "allDrives" : "user",
    });
    if (driveId) params.set("driveId", driveId);
    if (pageToken) params.set("pageToken", pageToken);

    const json = await driveFetchJson("/files", params);
    files.push(...(json.files || []));
    pageToken = json.nextPageToken || null;

    if (files.length >= limit) {
      hasMore = !!pageToken;
      break;
    }
    if (!pageToken) break;
    if (page === MAX_PAGES - 1) hasMore = true;
  }

  if (hasMore) {
    warnings.push(
      `結果が多いため上位 ${limit} 件で打ち切りました。--limit や --since で絞り込んでください。`
    );
  }

  const hits = files
    .slice(0, limit)
    .map(fileToHit)
    // allDrives 検索では API 側で並べ替えできないので更新の新しい順に自前で並べる
    .sort((a, b) => Date.parse(b.timestamp || 0) - Date.parse(a.timestamp || 0));

  return { hits, warnings, total: hits.length, hasMore };
}

/**
 * OAuth に使った Google アカウントがメンバーになっている共有ドライブの一覧。
 * `.env` の DRIVE_ID に設定する ID を調べるのに使う (bin/list-drives.mjs)。
 * @returns {Promise<{id:string, name:string, createdTime?:string}[]>}
 */
export async function listDrives() {
  const drives = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      pageSize: "100",
      fields: "nextPageToken, drives(id,name,createdTime)",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const json = await driveFetchJson("/drives", params);
    drives.push(...(json.drives || []));
    pageToken = json.nextPageToken || null;
    if (!pageToken) break;
  }
  return drives;
}

/**
 * Drive の URL または生の ID からファイル ID を取り出す。
 * 対応: /file/d/<id>/, /document/d/<id>/, /spreadsheets/d/<id>/,
 * /presentation/d/<id>/, /drive/folders/<id>, ?id=<id>、および生の ID。
 * @param {string} input
 * @returns {string}
 */
export function parseFileId(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("ファイル ID または Drive の URL を渡してください");
  if (!raw.includes("/") && !raw.includes("?")) return raw;

  const byPath = raw.match(/\/(?:d|folders)\/([A-Za-z0-9_-]{10,})/);
  if (byPath) return byPath[1];
  try {
    const id = new URL(raw).searchParams.get("id");
    if (id) return id;
  } catch {
    /* URL として解釈できなければ下のエラーに落とす */
  }
  throw new Error(`Drive のファイル ID を URL から取り出せません: ${raw}`);
}

/** ファイルのメタデータ (名前 / 種別 / 更新日時など) を取る。 */
export async function getFileMeta(fileId) {
  return driveFetchJson(
    `/files/${encodeURIComponent(fileId)}`,
    new URLSearchParams({
      fields:
        "id,name,mimeType,webViewLink,modifiedTime,createdTime,size," +
        "owners(displayName,emailAddress),lastModifyingUser(displayName)",
      supportsAllDrives: "true",
    })
  );
}

/**
 * Google ネイティブ形式をローカルで読める形に書き出すときの変換先。
 * スライドと図形描画は本文だけ抜くとレイアウトが失われるので PDF にする
 * (Claude Code の Read は PDF をそのまま読める)。
 */
const DOWNLOAD_EXPORT = {
  "application/vnd.google-apps.document": { mimeType: "text/plain", ext: ".txt" },
  "application/vnd.google-apps.spreadsheet": { mimeType: "text/csv", ext: ".csv" },
  "application/vnd.google-apps.presentation": { mimeType: "application/pdf", ext: ".pdf" },
  "application/vnd.google-apps.drawing": { mimeType: "application/pdf", ext: ".pdf" },
};

/** 拡張子が無い名前に、MIME から推測した拡張子を足す。 */
const EXT_BY_MIME = {
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "application/json": ".json",
  "image/png": ".png",
  "image/jpeg": ".jpg",
};

/** ファイル名からパス区切りと制御文字を落とす (ディレクトリ脱出の防止)。 */
function safeFileName(name) {
  return (
    String(name || "file")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f/\\]/g, "_")
      .replace(/^\.+/, "_")
      .slice(0, 120) || "file"
  );
}

/**
 * ファイルをローカルに落として、そのパスを返す (読み取り専用)。
 * Google ネイティブ形式は export、それ以外は alt=media でそのまま取得する。
 * PDF や Office ファイルもバイト列のまま落とせるので、Claude Code の Read で読める。
 *
 * このモジュールは Drive に対して GET しか投げない。書き込み・削除の API は
 * 意図的に実装していないので、プロンプトインジェクションでファイルを
 * 書き換えられる経路は存在しない (トークンも drive.readonly スコープ)。
 *
 * @param {{fileId:string, outDir?:string, maxBytes?:number, meta?:object}} opts
 * @returns {Promise<{path:string, name:string, mimeType:string, exportedAs:string|null,
 *                    bytes:number, webViewLink:string|null, modifiedTime:string|null}>}
 */
export async function downloadFile({ fileId, outDir, maxBytes = 50 * 1024 * 1024, meta }) {
  if (!fileId) throw new Error("fileId は必須です");
  const info = meta || (await getFileMeta(fileId));
  const mt = info.mimeType || "";

  if (mt === "application/vnd.google-apps.folder") {
    throw new Error("フォルダはダウンロードできません (中のファイルを指定してください)");
  }
  const declared = Number(info.size || 0);
  if (declared && declared > maxBytes) {
    throw new Error(
      `ファイルが大きすぎます (${Math.round(declared / 1024 / 1024)}MB > ` +
        `${Math.round(maxBytes / 1024 / 1024)}MB)。--max-mb で上限を上げられます。`
    );
  }

  const exportAs = DOWNLOAD_EXPORT[mt];
  if (!exportAs && mt.startsWith("application/vnd.google-apps.")) {
    throw new Error(`${kindOfMime(mt)} はダウンロードに対応していません`);
  }

  const res = exportAs
    ? await driveRequest(
        `/files/${encodeURIComponent(fileId)}/export`,
        new URLSearchParams({ mimeType: exportAs.mimeType })
      )
    : await driveRequest(
        `/files/${encodeURIComponent(fileId)}`,
        new URLSearchParams({ alt: "media", supportsAllDrives: "true" })
      );

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    throw new Error(
      `ファイルが大きすぎます (${Math.round(buf.length / 1024 / 1024)}MB)。--max-mb で上限を上げられます。`
    );
  }

  const dir = outDir || join(process.env.TMPDIR || "/tmp", "lab-assistant-drive");
  await mkdir(dir, { recursive: true });

  let name = safeFileName(info.name);
  const ext = exportAs ? exportAs.ext : EXT_BY_MIME[mt] || "";
  if (ext && !name.toLowerCase().endsWith(ext)) name += ext;
  // 同名ファイルの取り違えを避けるため ID の先頭を足す
  const path = join(dir, `${fileId.slice(0, 8)}_${name}`);
  await writeFile(path, buf);

  return {
    path,
    name: info.name || name,
    mimeType: mt,
    exportedAs: exportAs ? exportAs.mimeType : null,
    bytes: buf.length,
    webViewLink: info.webViewLink || null,
    modifiedTime: info.modifiedTime || null,
  };
}

/** 本文をプレーンテキストで書き出せる Google ネイティブ形式。 */
const EXPORT_MIME = {
  "application/vnd.google-apps.document": "text/plain",
  "application/vnd.google-apps.presentation": "text/plain",
  "application/vnd.google-apps.spreadsheet": "text/csv",
};

/**
 * ファイルの本文をプレーンテキストで取得する (要約や引用の補助用)。
 * Google ネイティブ形式は export、通常ファイルは alt=media。
 * バイナリ (PDF / 画像 / Office 等) は未対応で日本語エラーを投げる。
 * @param {{fileId:string, mimeType?:string, maxChars?:number}} opts
 * @returns {Promise<{text:string, truncated:boolean}>}
 */
export async function getFileText({ fileId, mimeType, maxChars = 4000 }) {
  if (!fileId) throw new Error("fileId は必須です");
  let mt = mimeType;
  if (!mt) {
    const meta = await driveFetchJson(
      `/files/${encodeURIComponent(fileId)}`,
      new URLSearchParams({ fields: "mimeType", supportsAllDrives: "true" })
    );
    mt = meta.mimeType;
  }

  let res;
  if (EXPORT_MIME[mt]) {
    res = await driveRequest(
      `/files/${encodeURIComponent(fileId)}/export`,
      new URLSearchParams({ mimeType: EXPORT_MIME[mt] })
    );
  } else if (String(mt).startsWith("application/vnd.google-apps.")) {
    throw new Error(`${kindOfMime(mt)} は本文のテキスト書き出しに対応していません`);
  } else if (
    String(mt).startsWith("text/") ||
    mt === "application/json" ||
    mt === "application/xml"
  ) {
    res = await driveRequest(
      `/files/${encodeURIComponent(fileId)}`,
      new URLSearchParams({ alt: "media", supportsAllDrives: "true" })
    );
  } else {
    throw new Error(
      `本文のテキスト取得に未対応の形式です (${mt})。Web で開いて確認してください。`
    );
  }

  const text = await res.text();
  const truncated = text.length > maxChars;
  return { text: truncated ? text.slice(0, maxChars) : text, truncated };
}
