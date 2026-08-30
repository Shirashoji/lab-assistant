// Google Calendar API v3 (REST) の薄いラッパ。依存ゼロ。
import { config } from "./config.mjs";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CAL_API = "https://www.googleapis.com/calendar/v3";

let cachedToken = null; // { accessToken, expiresAt }

export async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) {
    return cachedToken.accessToken;
  }
  const clientId = config.googleClientId;
  const clientSecret = config.googleClientSecret;
  const refreshToken = config.googleRefreshToken;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN のいずれかが未設定です。`node scripts/bin/auth-google.mjs` を実行してください。"
    );
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Google トークン更新に失敗 (${res.status}): ${json.error || ""} ${
        json.error_description || ""
      }`.trim()
    );
  }
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}

async function calFetch(path, { method = "GET", body } = {}) {
  const token = await getAccessToken();
  const res = await fetch(`${CAL_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `Calendar API ${res.status}: ${json.error?.message || JSON.stringify(json).slice(0, 300)}`
    );
  }
  return json;
}

export async function listCalendars() {
  return calFetch(`/users/me/calendarList`);
}

/**
 * @param {{timeMin:string, timeMax:string, q?:string, calendarId?:string}} opts
 */
export async function listEvents({ timeMin, timeMax, q, calendarId }) {
  const cal = encodeURIComponent(calendarId || config.calendarId);
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
  });
  if (q) params.set("q", q);
  const json = await calFetch(`/calendars/${cal}/events?${params}`);
  return json.items || [];
}

// ── 横断検索 (Phase 1) ─────────────────────────────────────

function eventToHit(ev, calendarId) {
  const start = ev.start?.dateTime || ev.start?.date || null;
  return {
    source: "calendar",
    title: ev.summary || "(無題の予定)",
    url: ev.htmlLink || null,
    snippet: [ev.location ? `📍 ${ev.location}` : "", (ev.description || "").trim()]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 200),
    author: ev.organizer?.displayName || ev.organizer?.email || null,
    timestamp: start,
    extra: {
      id: ev.id,
      calendarId: calendarId || config.calendarId,
      start: ev.start,
      end: ev.end,
      allDay: !!ev.start?.date,
      status: ev.status,
      location: ev.location || null,
      recurringEventId: ev.recurringEventId || null,
    },
  };
}

/**
 * Google Calendar をキーワード + 期間で検索する。
 * 既定の期間は「30 日前 〜 400 日後」。予定は開始時刻の昇順。
 * @param {{q?:string, since?:string, until?:string, calendarId?:string}} opts
 * @returns {Promise<{hits:object[], warnings:string[]}>}
 */
export async function searchEvents(opts = {}) {
  const now = Date.now();
  const timeMin = opts.since
    ? new Date(opts.since).toISOString()
    : new Date(now - 30 * 864e5).toISOString();
  const timeMax = opts.until
    ? new Date(opts.until).toISOString()
    : new Date(now + 400 * 864e5).toISOString();
  const calendarId = opts.calendarId || config.calendarId;
  const events = await listEvents({ timeMin, timeMax, q: opts.q || undefined, calendarId });
  return { hits: events.map((e) => eventToHit(e, calendarId)), warnings: [] };
}

/**
 * @param {object} eventBody Google Calendar Event resource
 * @param {string} [calendarId]
 */
export async function insertEvent(eventBody, calendarId) {
  const cal = encodeURIComponent(calendarId || config.calendarId);
  const ev = await calFetch(`/calendars/${cal}/events`, {
    method: "POST",
    body: eventBody,
  });
  return {
    id: ev.id,
    htmlLink: ev.htmlLink,
    summary: ev.summary,
    start: ev.start,
    end: ev.end,
  };
}

/**
 * 抽出済みイベント記述をそのまま作成する (toEventBody + insertEvent)。
 * @param {object} input create-event の入力スキーマ (summary/start 必須)
 */
export async function createEvent(input) {
  if (!input || !input.summary || !input.start) {
    throw new Error("summary と start は必須です");
  }
  return insertEvent(toEventBody(input), input.calendarId);
}

/**
 * 抽出済みイベント記述を Google Calendar Event resource に変換する。
 * @param {{summary:string, description?:string, location?:string,
 *          start:string, end?:string, allDay?:boolean, recurrence?:string[]}} e
 */
export function toEventBody(e) {
  const tz = config.timezone;
  const body = {
    summary: e.summary,
    description: e.description || undefined,
    location: e.location || undefined,
  };
  if (e.allDay) {
    // start/end は YYYY-MM-DD。end は排他的なので終了日 +1 日 (未指定なら start+1)
    const startDate = e.start.slice(0, 10);
    const endDate = e.end
      ? e.end.slice(0, 10)
      : addDays(startDate, 1);
    body.start = { date: startDate };
    body.end = { date: endDate };
  } else {
    const startISO = e.start;
    const endISO = e.end || addMinutesISO(startISO, 60);
    body.start = { dateTime: startISO, timeZone: tz };
    body.end = { dateTime: endISO, timeZone: tz };
  }
  if (Array.isArray(e.recurrence) && e.recurrence.length) {
    body.recurrence = e.recurrence;
  }
  return body;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function addMinutesISO(iso, minutes) {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() + minutes);
  // 元の文字列がオフセット付きならそれを保持したいが、簡易的に ISO(Z) を返す
  return d.toISOString();
}
