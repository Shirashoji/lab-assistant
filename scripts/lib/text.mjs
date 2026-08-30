// 検索まわりの素朴なテキストユーティリティ。依存ゼロ。

/** 全角英数を半角化し、小文字化して比較用に正規化する。 */
export function normalizeText(s) {
  return String(s || "")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase();
}

/** クエリを空白区切りのトークンに分解する。空白の無い日本語クエリはそのまま 1 トークン。 */
export function tokenize(query) {
  return String(query || "")
    .split(/[\s　]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** haystack が terms を **すべて** 含むか (AND, 大文字小文字・全半角を無視)。 */
export function matchesAllTerms(haystack, terms) {
  if (!terms || terms.length === 0) return true;
  const h = normalizeText(haystack);
  return terms.every((t) => h.includes(normalizeText(t)));
}

/** 検索語の周辺を優先して抜粋する。 */
export function excerpt(text, terms = [], max = 200) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const h = normalizeText(clean);
  let at = -1;
  for (const t of terms) {
    const i = h.indexOf(normalizeText(t));
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at <= 0) return clean.slice(0, max) + "…";
  const start = Math.max(0, at - Math.floor(max / 3));
  return (start > 0 ? "…" : "") + clean.slice(start, start + max) + "…";
}
