// 検索クエリの拡張。依存ゼロ。
//
// 研究室の情報は「同じことを別の言葉で」書かれている。
//   例) 「中間報告会」は esa では「中間発表」、Discord では「中間」、
//       Slack では「中間発表会」と書かれていたりする。
// 完全一致だけだと取りこぼすので、クエリの各語を **関連語のグループ** に広げ、
//   - グループ内は OR (どれかにマッチすればよい)
//   - グループ間は AND (すべてのグループにマッチする必要がある)
// という形で検索する。
//
// 拡張は 2 段階:
//   1. 辞書 (SYNONYMS) … 研究室ドメインの言い換え・和英・略語
//   2. 機械的な変種 (mechanicalVariants) … 表記ゆれ (長音/中黒/空白/複数形など)
//
// 呼び出し側は expandQuery() の返す groups を使う。拡張を切りたいときは
// { enabled: false } を渡すと元の語だけのグループになる。

import { normalizeText, tokenize } from "./text.mjs";

/**
 * 研究室ドメインの同義語グループ。
 * 1 行が 1 グループで、どれか 1 語がクエリに現れたらグループ全体に広げる。
 * 追加するときは「その語で書かれた記事/メッセージが実際にある」ものだけにする。
 * (無関係な語を入れるとノイズが増える)
 */
const SYNONYMS = [
  // ── 研究室の行事・会議 ──────────────────────────────
  ["ゼミ", "セミナー", "seminar", "研究会"],
  ["ミーティング", "mtg", "meeting", "打ち合わせ", "打合せ", "面談"],
  ["中間報告", "中間発表", "中間報告会", "中間発表会", "中間審査"],
  ["最終発表", "最終報告", "最終発表会", "最終報告会", "本審査"],
  ["卒論", "卒業論文", "卒業研究", "卒研"],
  ["修論", "修士論文", "修士研究"],
  ["予稿", "原稿", "abstract", "アブスト"],
  ["発表", "プレゼン", "presentation", "登壇", "講演"],
  ["スライド", "slide", "slides", "資料", "発表資料"],
  ["合宿", "ゼミ合宿", "研究室合宿", "camp"],
  ["進捗", "progress", "進捗報告"],
  ["週報", "weekly", "weekly report", "週次報告"],
  ["輪読", "輪講", "reading", "文献購読"],
  ["就活", "就職活動", "インターン", "internship", "採用"],
  ["学会", "conference", "国際会議", "研究発表会"],
  ["論文", "paper", "文献", "ペーパー"],
  ["締切", "締め切り", "deadline", "〆切", "期限"],

  // ── 可視化まわり ────────────────────────────────────
  [
    "可視化",
    "ビジュアライゼーション",
    "visualization",
    "visualisation",
    "viz",
    "ビジュアライズ",
    "データビジュアライゼーション",
  ],
  ["グラフ描画", "graph drawing", "グラフレイアウト", "graph layout"],
  ["ネットワーク図", "network diagram", "ノードリンク", "node-link"],
  ["チャート", "chart", "図", "プロット", "plot"],
  ["ダッシュボード", "dashboard"],
  ["インタラクション", "interaction", "操作"],

  // ── 技術・ツール ────────────────────────────────────
  ["グラフ", "graph", "ネットワーク", "network"],
  ["木", "tree", "ツリー"],
  ["根付き木", "rooted tree", "有根木"],
  ["トーラス", "torus", "トーラスグラフ"],
  ["埋め込み", "embedding", "レイアウト", "layout"],
  ["機械学習", "machine learning", "ml", "深層学習", "ディープラーニング", "deep learning"],
  ["最適化", "optimization", "optimisation", "最適解"],
  ["mcp", "model context protocol"],
  ["エージェント", "agent", "ai エージェント"],
  ["生成 ai", "生成ai", "llm", "大規模言語モデル", "chatgpt", "claude"],
  ["フロントエンド", "frontend", "front-end"],
  ["バックエンド", "backend", "back-end"],
  ["リファクタ", "リファクタリング", "refactoring"],
  ["環境構築", "セットアップ", "setup", "インストール", "install"],
  ["不具合", "バグ", "bug", "エラー", "error", "障害"],

  // ── 研究室運営 ──────────────────────────────────────
  ["先生", "教員", "教授", "指導教員", "尾上"],
  ["新入生", "新歓", "配属", "研究室配属"],
  ["予算", "経費", "費用", "支給", "申請"],
  ["日程", "スケジュール", "schedule", "予定", "日時"],
  ["場所", "会場", "教室", "room", "ロケーション"],
  ["オンライン", "リモート", "zoom", "online", "remote"],
];

/** normalize 済みの語 → そのグループ(normalize 済み配列) の索引 */
const SYNONYM_INDEX = (() => {
  const idx = new Map();
  for (const group of SYNONYMS) {
    const norm = group.map((g) => normalizeText(g));
    for (const g of norm) {
      // 同じ語が複数グループに出るときは全部つなげる
      const prev = idx.get(g) || [];
      idx.set(g, [...new Set([...prev, ...norm])]);
    }
  }
  return idx;
})();

/** 長音・中黒・空白・ハイフンを落とした比較用の形 */
function loose(s) {
  return normalizeText(s).replace(/[ー・\-–—_\s]/g, "");
}

/**
 * 表記ゆれの機械的な変種。辞書に無い語でも拾えるようにする。
 * 例) "データ可視化" → "データ可視化" / "データ可視化"(長音除去) …
 *     "APIs" → "api"
 */
function mechanicalVariants(term) {
  const out = new Set();
  const n = normalizeText(term);
  out.add(n);

  // 長音・中黒・ハイフン・空白の有無ゆれ ("ユーザー" ↔ "ユーザ")
  const l = loose(n);
  if (l && l !== n) out.add(l);
  if (/ー$/.test(n)) out.add(n.replace(/ー$/, ""));

  // 英語の複数形/三人称単数 ("graphs" → "graph")
  if (/^[a-z0-9\-]+$/.test(n)) {
    if (/ies$/.test(n)) out.add(n.replace(/ies$/, "y"));
    else if (/(ches|shes|xes|ses)$/.test(n)) out.add(n.replace(/es$/, ""));
    else if (/s$/.test(n) && !/ss$/.test(n)) out.add(n.replace(/s$/, ""));
    if (/ing$/.test(n) && n.length > 5) out.add(n.replace(/ing$/, ""));
  }

  return [...out].filter(Boolean);
}

/** その語の同義語グループ (無ければ空配列) */
function synonymsFor(term) {
  const n = normalizeText(term);
  const direct = SYNONYM_INDEX.get(n);
  if (direct) return direct;
  // 長音などを落とした形でも引く ("ビジュアライゼーション" ↔ "ビジュアライゼーシヨン" 等)
  const l = loose(n);
  for (const [key, group] of SYNONYM_INDEX) {
    if (loose(key) === l) return group;
  }
  return [];
}

/**
 * クエリを関連語のグループに展開する。
 *
 * @param {string} query
 * @param {{enabled?:boolean, extraTerms?:string[], maxVariantsPerTerm?:number}} [opts]
 *   - enabled: false なら拡張せず元の語だけ (既定 true)
 *   - extraTerms: 呼び出し側 (スキル/LLM) が足したい関連語。全グループに OR で足すのではなく
 *     **独立したグループ** として OR 側に足す。つまり「元の語 OR 追加語」になる。
 *   - maxVariantsPerTerm: 1 グループあたりの語数上限 (既定 12)
 * @returns {{original:string, tokens:string[], groups:{base:string,variants:string[]}[],
 *            allTerms:string[], expanded:boolean}}
 */
export function expandQuery(query, opts = {}) {
  const { enabled = true, extraTerms = [], maxVariantsPerTerm = 12 } = opts;
  const original = String(query || "").trim();
  const tokens = tokenize(original);

  if (!tokens.length) {
    return { original, tokens: [], groups: [], allTerms: [], expanded: false };
  }

  const groups = tokens.map((tok) => {
    const variants = new Set([normalizeText(tok)]);
    if (enabled) {
      for (const v of mechanicalVariants(tok)) variants.add(v);
      for (const s of synonymsFor(tok)) {
        variants.add(s);
        for (const v of mechanicalVariants(s)) variants.add(v);
      }
    }
    return {
      base: tok,
      variants: [...variants].filter(Boolean).slice(0, maxVariantsPerTerm),
    };
  });

  // 呼び出し側が渡した関連語は、クエリ全体の言い換えとみなして
  // 「(元クエリ全体) OR (追加語)」になるよう先頭グループに足す。
  const extras = (extraTerms || []).map((t) => String(t).trim()).filter(Boolean);
  if (enabled && extras.length && groups.length) {
    for (const e of extras) {
      for (const v of mechanicalVariants(e)) groups[0].variants.push(v);
    }
    groups[0].variants = [...new Set(groups[0].variants)];
  }

  const allTerms = [...new Set(groups.flatMap((g) => g.variants))];
  const expanded = allTerms.length > tokens.length;

  return { original, tokens, groups, allTerms, expanded };
}

/**
 * 展開したグループを、OR/AND をサポートする検索 API のクエリ文字列にする。
 * 例) [{variants:["ゼミ","seminar"]},{variants:["日程"]}]
 *     → `(ゼミ OR seminar) 日程`
 *
 * @param {{base:string,variants:string[]}[]} groups
 * @param {{or?:string, quote?:(s:string)=>string, maxVariants?:number}} [opts]
 *   - or: OR 演算子の綴り (既定 "OR")
 *   - quote: 語のクォート方法 (既定: 空白を含む語だけ "..." で囲む)
 */
export function groupsToQuery(groups, opts = {}) {
  const { or = "OR", maxVariants = 6 } = opts;
  const quote =
    opts.quote || ((s) => (/[\s　]/.test(s) ? `"${s}"` : s));
  const parts = [];
  for (const g of groups || []) {
    const vs = (g.variants || []).slice(0, maxVariants).map(quote);
    if (!vs.length) continue;
    parts.push(vs.length === 1 ? vs[0] : `(${vs.join(` ${or} `)})`);
  }
  return parts.join(" ");
}

/** 展開結果を人間向けに 1 行で説明する ("ゼミ → ゼミ/seminar/研究会" のような形)。 */
export function describeExpansion(expansion) {
  if (!expansion?.expanded) return null;
  return expansion.groups
    .filter((g) => g.variants.length > 1)
    .map((g) => `${g.base} → ${g.variants.join(" / ")}`)
    .join(" ; ");
}
