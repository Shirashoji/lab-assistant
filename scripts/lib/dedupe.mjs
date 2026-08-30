// 予定の重複候補を Google Calendar から洗い出す共通ロジック。
// 「同一かどうか」の最終判断は呼び出し側 (LLM) が意味的に行う前提。
import { listEvents } from "./gcal.mjs";

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[\s　]+/g, "")
    .replace(/[!-/:-@[-`{-~、。・「」『』（）()]/g, "");
}

function eventStartMs(ev) {
  const s = ev.start?.dateTime || ev.start?.date;
  return s ? new Date(s).getTime() : NaN;
}

function sharePrefix(a, b) {
  const n = Math.min(a.length, b.length, 6);
  return n >= 4 && a.slice(0, n) === b.slice(0, n);
}

/**
 * @param {{summary:string, start:string, end?:string, calendarId?:string}} q
 */
export async function findDuplicateCandidates(q) {
  const { summary, start, calendarId } = q;
  if (!summary || !start) throw new Error("summary と start は必須です");
  const startMs = new Date(start).getTime();
  if (Number.isNaN(startMs)) throw new Error(`start をパースできません: ${start}`);

  const windowMs = 26 * 60 * 60 * 1000;
  const timeMin = new Date(startMs - windowMs).toISOString();
  const timeMax = new Date(startMs + windowMs).toISOString();

  const qWord = summary.split(/[\s　]+/).sort((a, b) => b.length - a.length)[0];

  let events = await listEvents({
    timeMin,
    timeMax,
    q: qWord && qWord.length >= 2 ? qWord : undefined,
    calendarId,
  });
  // q なしでも一度取得してマージ (q が効きすぎるケースの保険)
  try {
    const all = await listEvents({ timeMin, timeMax, calendarId });
    const seen = new Set(events.map((e) => e.id));
    for (const e of all) if (!seen.has(e.id)) events.push(e);
  } catch {
    /* ignore */
  }

  const targetNorm = normalize(summary);
  const candidates = events
    .map((ev) => {
      const evNorm = normalize(ev.summary);
      const startDiffMin = Math.round(Math.abs(eventStartMs(ev) - startMs) / 60000);
      const titleOverlap =
        !!evNorm &&
        !!targetNorm &&
        (evNorm.includes(targetNorm) ||
          targetNorm.includes(evNorm) ||
          sharePrefix(evNorm, targetNorm));
      const sameDay =
        new Date(eventStartMs(ev)).toDateString() ===
        new Date(startMs).toDateString();
      return {
        id: ev.id,
        summary: ev.summary,
        start: ev.start,
        end: ev.end,
        location: ev.location || null,
        htmlLink: ev.htmlLink,
        startDiffMinutes: Number.isNaN(startDiffMin) ? null : startDiffMin,
        sameDay,
        titleOverlap,
        likelyMatch: titleOverlap && (startDiffMin <= 90 || sameDay),
      };
    })
    .sort((a, b) => (a.startDiffMinutes ?? 1e9) - (b.startDiffMinutes ?? 1e9));

  return { query: { summary, start }, window: { timeMin, timeMax }, candidates };
}
