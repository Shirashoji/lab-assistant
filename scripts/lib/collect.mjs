// URL 群 (Discord メッセージ / esa 記事) から予定抽出用の文脈を収集する。
// bin/collect-context.mjs と mcp-server の両方から使う共通ロジック。
import { classifyUrl, findEsaUrls } from "./url.mjs";
import { collectContext } from "./discord.mjs";
import { getPost } from "./esa.mjs";

function textFromDiscordBundle(bundle) {
  const parts = [];
  const push = (m) => {
    if (!m) return;
    parts.push(m.content || "");
    for (const e of m.embeds || []) parts.push(e.description || "", e.title || "");
  };
  push(bundle.target);
  (bundle.replyChain || []).forEach(push);
  (bundle.siblings || []).forEach(push);
  if (bundle.thread) {
    push(bundle.thread.starterMessage);
    (bundle.thread.firstMessages || []).forEach(push);
  }
  return parts.join("\n");
}

/**
 * @param {string[]} urls
 * @returns {Promise<{inputUrls:string[], generatedAt:string, sources:object[], warnings:string[]}>}
 */
export async function collectFromUrls(urls) {
  const list = (urls || []).map((u) => String(u).trim()).filter(Boolean);
  const sources = [];
  const warnings = [];
  const esaSeen = new Set();

  for (const url of list) {
    const c = classifyUrl(url);
    try {
      if (c.kind === "discord") {
        const bundle = await collectContext(c);
        warnings.push(...(bundle.warnings || []));
        sources.push(bundle);
        for (const ref of findEsaUrls(textFromDiscordBundle(bundle))) {
          const key = `${ref.team}/${ref.postNumber}`;
          if (esaSeen.has(key)) continue;
          esaSeen.add(key);
          try {
            sources.push({ ...(await getPost(ref)), via: "discord-link" });
          } catch (e) {
            warnings.push(`esa 記事 ${ref.url} の取得に失敗: ${e.message}`);
          }
        }
      } else if (c.kind === "esa") {
        const key = `${c.team}/${c.postNumber}`;
        if (esaSeen.has(key)) continue;
        esaSeen.add(key);
        sources.push(await getPost(c));
      } else {
        warnings.push(`未対応の URL 形式です: ${url}`);
      }
    } catch (e) {
      warnings.push(`${url} の処理に失敗: ${e.message}`);
    }
  }

  return {
    inputUrls: list,
    generatedAt: new Date().toISOString(),
    sources,
    warnings,
  };
}
