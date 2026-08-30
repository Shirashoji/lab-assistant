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

// ── 関連語グループ (lib/expand.mjs) 向けのマッチング ────────────────

/**
 * 短い英字の語 ("ml" / "viz" / "mcp") は素の部分一致だと誤爆する
 * ("ml" が "html" に、"ai" が "chain" に当たる)。
 * 英数字のみ 4 文字以下の語は、前後が英数字でないこと (語境界) を要求する。
 * 日本語には語境界が無いので従来どおり部分一致。
 */
function containsTerm(haystackNorm, term) {
  const t = normalizeText(term);
  if (!t) return false;
  if (!/^[a-z0-9]{1,4}$/.test(t)) return haystackNorm.includes(t);
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${esc}([^a-z0-9]|$)`).test(haystackNorm);
}

/**
 * haystack が **すべてのグループ** にマッチするか。
 * グループ内は OR (どれか 1 語)、グループ間は AND。
 * groups が空なら true (絞り込み無し)。
 * @param {string} haystack
 * @param {{base:string, variants:string[]}[]} groups
 */
export function matchesGroups(haystack, groups) {
  if (!groups || groups.length === 0) return true;
  const h = normalizeText(haystack);
  return groups.every((g) => {
    const vs = g.variants?.length ? g.variants : [g.base];
    return vs.some((v) => v && containsTerm(h, v));
  });
}

/**
 * ヒットの「効き具合」を 0〜1 で返す。並び替えの補助に使う。
 * 元の語そのものが入っているほど高く、関連語だけのマッチは低くなる。
 * @param {string} haystack
 * @param {{base:string, variants:string[]}[]} groups
 * @param {string} [original] 元のクエリ全体 (連続一致なら加点)
 */
export function scoreGroups(haystack, groups, original = "") {
  if (!groups || groups.length === 0) return 0;
  const h = normalizeText(haystack);
  let score = 0;
  for (const g of groups) {
    const base = g.base;
    if (base && containsTerm(h, base)) {
      score += 1; // 元の語そのもの
      continue;
    }
    const vs = g.variants?.length ? g.variants : [];
    if (vs.some((v) => v && containsTerm(h, v))) score += 0.5; // 関連語
  }
  let s = score / groups.length;
  // クエリ全体がそのまま入っていれば強いヒット
  const orig = normalizeText(original);
  if (orig && orig.length > 1 && h.includes(orig)) s = Math.min(1, s + 0.25);
  return s;
}

/** グループの全語をフラットな配列にする (excerpt 用)。 */
export function groupTerms(groups) {
  if (!groups?.length) return [];
  return [...new Set(groups.flatMap((g) => (g.variants?.length ? g.variants : [g.base])))];
}
