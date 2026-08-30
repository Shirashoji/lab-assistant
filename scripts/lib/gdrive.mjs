// Google Drive API v3 (REST) の薄いラッパ + 全文検索。依存ゼロ。
//
// 認証は Calendar と同じ OAuth (GOOGLE_CLIENT_ID / SECRET / GOOGLE_REFRESH_TOKEN) を
// そのまま再利用する (gcal.mjs の getAccessToken)。ただし Drive を読むには
// `drive.readonly` スコープが要る。既存のリフレッシュトークンは Calendar スコープしか
// 持っていないので、その場合は `node scripts/bin/auth-google.mjs` を再実行して
// トークンを取り直す必要がある (403 のときに日本語でその旨を投げる)。
import { getAccessToken } from "./gcal.mjs";

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
function buildQuery({ query, since, until, folderIds, mimeTypes }) {
  const parts = [];
  const q = String(query || "").trim();
  if (q) parts.push(`fullText contains '${escapeQueryValue(q)}'`);
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
 * 共有ドライブ (`corpora=allDrives`) も対象にする。
 * @param {{query:string, since?:string, until?:string, limit?:number,
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
  } = opts;
  const limit = Math.max(1, Number(opts.limit) || 20);
  const q = buildQuery({ query, since, until, folderIds, mimeTypes });
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
      // 共有ドライブを含めて横断検索する (allDrives では orderBy が使えないので後で自前ソート)
      corpora: includeShared ? "allDrives" : "user",
    });
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
