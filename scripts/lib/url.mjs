// URL の分類と抽出。依存ゼロ。

const DISCORD_RE =
  /^https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/(\d+|@me)\/(\d+)\/(\d+)/i;

// https://<team>.esa.io/posts/<n>  (末尾に /edit や #comment-... が付くこともある)
const ESA_RE = /^https?:\/\/([a-z0-9][a-z0-9-]*)\.esa\.io\/posts\/(\d+)/i;

const URL_IN_TEXT_RE = /https?:\/\/[^\s<>()"'\]]+/g;

/**
 * @param {string} url
 * @returns {{kind:"discord",guildId:string,channelId:string,messageId:string}
 *          | {kind:"esa",team:string,postNumber:number}
 *          | {kind:"other",url:string}}
 */
export function classifyUrl(url) {
  const u = String(url).trim();
  const d = u.match(DISCORD_RE);
  if (d) {
    return {
      kind: "discord",
      guildId: d[1],
      channelId: d[2],
      messageId: d[3],
    };
  }
  const e = u.match(ESA_RE);
  if (e) {
    return { kind: "esa", team: e[1], postNumber: Number(e[2]) };
  }
  return { kind: "other", url: u };
}

/** テキスト中の URL をすべて返す (末尾の句読点を軽く除去) */
export function extractUrls(text) {
  if (!text) return [];
  const matches = String(text).match(URL_IN_TEXT_RE) || [];
  return matches.map((m) => m.replace(/[.,。、)\]]+$/, ""));
}

/** テキスト中の esa 記事 URL を {team, postNumber, url} で返す (重複除去) */
export function findEsaUrls(text) {
  const seen = new Set();
  const out = [];
  for (const raw of extractUrls(text)) {
    const c = classifyUrl(raw);
    if (c.kind !== "esa") continue;
    const key = `${c.team}/${c.postNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ team: c.team, postNumber: c.postNumber, url: raw });
  }
  return out;
}
