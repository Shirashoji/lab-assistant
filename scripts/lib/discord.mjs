// Discord REST v10 の薄いラッパと文脈収集。依存ゼロ。
import { config } from "./config.mjs";
import { tokenize, matchesGroups, excerpt, groupTerms } from "./text.mjs";

const API = "https://discord.com/api/v10";

// スレッド系 channel type
const THREAD_TYPES = new Set([10, 11, 12]);

async function apiGet(path, { retry = 1 } = {}) {
  const token = config.discordToken;
  if (!token) throw new Error("DISCORD_BOT_TOKEN が未設定です");
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "lab-assistant (https://github.com/, 0.1.0)",
    },
  });
  if (res.status === 429 && retry > 0) {
    const body = await res.json().catch(() => ({}));
    const wait = Math.min((body.retry_after ?? 1) * 1000, 5000);
    await new Promise((r) => setTimeout(r, wait));
    return apiGet(path, { retry: retry - 1 });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const hint =
      res.status === 401
        ? " (トークンが無効です)"
        : res.status === 403
        ? " (Bot にこのチャンネルの閲覧/履歴読み取り権限がありません)"
        : res.status === 404
        ? " (メッセージ/チャンネルが見つかりません。Bot が対象サーバーに参加しているか確認してください)"
        : "";
    throw new Error(`Discord API ${res.status}${hint}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

function normalizeMessage(m) {
  return {
    id: m.id,
    content: m.content || "",
    author: m.author
      ? {
          id: m.author.id,
          name: m.author.global_name || m.author.username || m.author.id,
          bot: !!m.author.bot,
        }
      : null,
    timestamp: m.timestamp,
    editedTimestamp: m.edited_timestamp || null,
    attachments: (m.attachments || []).map((a) => ({
      filename: a.filename,
      url: a.url,
      contentType: a.content_type || null,
    })),
    embeds: (m.embeds || []).map((e) => ({
      title: e.title || null,
      description: e.description || null,
      url: e.url || null,
      fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value })),
    })),
    referencedMessageId: m.message_reference?.message_id || null,
  };
}

export function messageUrl({ guildId, channelId, messageId }) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export async function getMessage(channelId, messageId) {
  return normalizeMessage(await apiGet(`/channels/${channelId}/messages/${messageId}`));
}

export async function getChannel(channelId) {
  return apiGet(`/channels/${channelId}`);
}

export async function getAround(channelId, messageId, limit = 25) {
  const arr = await apiGet(
    `/channels/${channelId}/messages?around=${messageId}&limit=${limit}`
  );
  return arr.map(normalizeMessage);
}

export async function getThreadMessages(threadId, limit = 30) {
  const arr = await apiGet(`/channels/${threadId}/messages?limit=${limit}`);
  return arr.map(normalizeMessage);
}

// ── 横断検索 (Phase 1) ─────────────────────────────────────
// Discord のメッセージ検索エンドポイント (GET /guilds/{id}/messages/search) は
// ユーザートークン専用で Bot では 403 になる。そのため対象チャンネルの最近の
// メッセージを遡って取得し、クライアント側でフィルタする。
//
// ギルドのチャンネル数は数百規模になり得るので:
//  - スノーフレークから最終発言時刻を割り出し、検索期間より前しか動きの無い
//    チャンネルは最初から除外する
//  - 直近の活動が新しい順に並べ、上限 (maxChannels) までに絞る
//  - チャンネル取得は並列度を制限して同時実行する

const SEARCHABLE_TEXT = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT
const SEARCHABLE_THREAD = new Set([10, 11, 12]);
const DISCORD_EPOCH = 1420070400000;

/** スノーフレーク ID → 生成時刻(ms)。null 安全。 */
export function snowflakeToMs(id) {
  if (!id) return null;
  try {
    return Number(BigInt(id) >> 22n) + DISCORD_EPOCH;
  } catch {
    return null;
  }
}

/** items を並列度 limit で処理する。 */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Bot が参加しているギルド一覧。 */
export async function listMyGuilds() {
  const arr = await apiGet(`/users/@me/guilds`);
  return arr.map((g) => ({ id: g.id, name: g.name }));
}

/** ギルドのチャンネル一覧 (生の Discord オブジェクト)。 */
export async function listGuildChannels(guildId) {
  return apiGet(`/guilds/${guildId}/channels`);
}

/** ギルドのアクティブなスレッド一覧。 */
export async function listActiveThreads(guildId) {
  const j = await apiGet(`/guilds/${guildId}/threads/active`);
  return j.threads || [];
}

async function getMessagesBefore(channelId, { before, limit = 100 } = {}) {
  const p = new URLSearchParams({ limit: String(limit) });
  if (before) p.set("before", before);
  const arr = await apiGet(`/channels/${channelId}/messages?${p}`);
  return arr.map(normalizeMessage);
}

async function channelMeta(id) {
  try {
    const c = await getChannel(id);
    return {
      id,
      name: c.name || null,
      guildId: c.guild_id || null,
      type: c.type,
      lastMessageId: c.last_message_id || null,
    };
  } catch {
    return { id, name: null, guildId: null, type: null, lastMessageId: null };
  }
}

/**
 * 検索対象チャンネルを解決する。
 * - channelAllowList があればそれだけを対象にする。
 * - なければ対象ギルド (未指定なら Bot の全ギルド) のテキストチャンネル + アクティブスレッド。
 */
export async function resolveSearchChannels({ guildIds, channelAllowList } = {}) {
  const warnings = [];
  if (channelAllowList && channelAllowList.length) {
    const metas = await Promise.all(channelAllowList.map(channelMeta));
    return { channels: metas, warnings };
  }

  let guilds = guildIds && guildIds.length ? guildIds : null;
  if (!guilds) {
    try {
      guilds = (await listMyGuilds()).map((g) => g.id);
    } catch (e) {
      warnings.push(`Bot のギルド一覧取得に失敗: ${e.message}`);
      guilds = [];
    }
  }

  const channels = new Map();
  for (const gid of guilds) {
    try {
      for (const c of await listGuildChannels(gid)) {
        if (SEARCHABLE_TEXT.has(c.type)) {
          channels.set(c.id, {
            id: c.id,
            name: c.name || null,
            guildId: gid,
            type: c.type,
            lastMessageId: c.last_message_id || null,
          });
        }
      }
    } catch (e) {
      warnings.push(`ギルド ${gid} のチャンネル取得に失敗: ${e.message}`);
    }
    try {
      for (const t of await listActiveThreads(gid)) {
        if (SEARCHABLE_THREAD.has(t.type)) {
          channels.set(t.id, {
            id: t.id,
            name: t.name || null,
            guildId: gid,
            type: t.type,
            lastMessageId: t.last_message_id || null,
          });
        }
      }
    } catch (e) {
      warnings.push(`ギルド ${gid} のアクティブスレッド取得に失敗: ${e.message}`);
    }
  }
  return { channels: [...channels.values()], warnings };
}

function toDiscordHit(m, ch, terms) {
  const body =
    m.content ||
    (m.embeds || [])
      .map((e) => [e.title, e.description].filter(Boolean).join(" — "))
      .join(" / ");
  return {
    source: "discord",
    title: `#${ch.name || ch.id}${m.author ? ` / ${m.author.name}` : ""}`,
    url: ch.guildId
      ? messageUrl({ guildId: ch.guildId, channelId: ch.id, messageId: m.id })
      : null,
    snippet: excerpt(body, terms),
    author: m.author?.name || null,
    timestamp: m.timestamp || null,
    extra: {
      channelId: ch.id,
      channelName: ch.name || null,
      messageId: m.id,
      bot: !!m.author?.bot,
      isThread: SEARCHABLE_THREAD.has(ch.type),
      attachments: (m.attachments || []).length,
      urls: (m.embeds || []).map((e) => e.url).filter(Boolean),
    },
  };
}

/**
 * Discord をキーワード横断検索する。
 * @param {{query:string, channelIds?:string[], guildIds?:string[],
 *          channelAllowList?:string[], since?:string, until?:string,
 *          maxPagesPerChannel?:number, maxChannels?:number,
 *          concurrency?:number, limit?:number}} opts
 */
export async function searchMessages(opts = {}) {
  const {
    query,
    channelIds,
    guildIds,
    channelAllowList,
    since,
    until,
    maxChannels = 80,
    concurrency = 12,
    limit = 40,
  } = opts;
  // 関連語グループ (lib/expand.mjs) が渡ればそれで、無ければ元のクエリ語で絞り込む。
  const groups =
    opts.groups?.length
      ? opts.groups
      : tokenize(query).map((t) => ({ base: t, variants: [t] }));
  if (groups.length === 0) throw new Error("検索キーワードが空です");
  const terms = groupTerms(groups);
  const warnings = [];
  const explicit = !!((channelIds && channelIds.length) || (channelAllowList && channelAllowList.length));

  let targets;
  if (channelIds && channelIds.length) {
    targets = await Promise.all(channelIds.map(channelMeta));
  } else {
    const r = await resolveSearchChannels({ guildIds, channelAllowList });
    targets = r.channels;
    warnings.push(...r.warnings);
  }

  const sinceMs = since ? new Date(since).getTime() : -Infinity;
  const untilMs = until ? new Date(until).getTime() : Infinity;
  // 期間指定が無いときは 1 ページ (直近 100 件) のみ。指定時は遡る。
  const maxPages = opts.maxPagesPerChannel ?? (since ? 4 : 1);

  const candidateCount = targets.length;
  if (!explicit) {
    // 検索期間より後に活動が無いチャンネルを除外し、活動が新しい順に並べる
    targets = targets
      .filter((ch) => {
        const last = snowflakeToMs(ch.lastMessageId);
        return last === null || last >= sinceMs;
      })
      .sort((a, b) => String(b.lastMessageId || "").localeCompare(String(a.lastMessageId || "")));
    if (targets.length > maxChannels) {
      warnings.push(
        `対象チャンネルが ${targets.length} 件。活動の新しい ${maxChannels} 件に絞りました` +
          `(--max-channels で変更、--channels でチャンネル指定、--since で期間指定が可能)`
      );
      targets = targets.slice(0, maxChannels);
    }
  }

  const noAccess = [];
  const otherErrors = [];
  const perChannel = await mapLimit(targets, concurrency, async (ch) => {
    const found = [];
    let before;
    for (let page = 0; page < maxPages; page++) {
      let msgs;
      try {
        msgs = await getMessagesBefore(ch.id, { before, limit: 100 });
      } catch (e) {
        if (/\b403\b/.test(e.message)) noAccess.push(ch.name || ch.id);
        else otherErrors.push(`#${ch.name || ch.id}: ${e.message}`);
        break;
      }
      if (!msgs.length) break;
      for (const m of msgs) {
        const ts = new Date(m.timestamp).getTime();
        if (ts < sinceMs || ts > untilMs) continue;
        const hay =
          (m.content || "") +
          " " +
          (m.embeds || []).map((e) => `${e.title || ""} ${e.description || ""}`).join(" ");
        if (matchesGroups(hay, groups)) found.push(toDiscordHit(m, ch, terms));
      }
      const oldestMs = new Date(msgs[msgs.length - 1].timestamp).getTime();
      before = msgs[msgs.length - 1].id;
      if (oldestMs < sinceMs || msgs.length < 100) break;
    }
    return found;
  });

  if (noAccess.length) {
    const sample = noAccess.slice(0, 5).map((n) => `#${n}`).join(", ");
    warnings.push(
      `Bot に閲覧権限が無いチャンネルが ${noAccess.length} 件あり検索対象外です` +
        ` (例: ${sample}${noAccess.length > 5 ? " ほか" : ""})。` +
        `対象チャンネルで Bot ロールに「チャンネルを見る」「メッセージ履歴を読む」を付与してください。`
    );
  }
  for (const e of otherErrors.slice(0, 5)) warnings.push(e);

  const hits = perChannel.flat();
  hits.sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
  return {
    hits: hits.slice(0, limit),
    warnings,
    searchedChannels: targets.length,
    candidateChannels: candidateCount,
    forbiddenChannels: noAccess.length,
  };
}

const MINUTE = 60_000;

/**
 * 対象メッセージ + 周辺文脈を収集する。
 * @param {{guildId:string, channelId:string, messageId:string}} ref
 */
export async function collectContext({ guildId, channelId, messageId }) {
  const warnings = [];
  const target = await getMessage(channelId, messageId);

  let channel = null;
  try {
    channel = await getChannel(channelId);
  } catch (e) {
    warnings.push(`チャンネル情報の取得に失敗: ${e.message}`);
  }

  // 返信チェーンを上へ辿る (最大 6 ホップ)
  const replyChain = [];
  let cursor = target.referencedMessageId;
  const visited = new Set([messageId]);
  for (let i = 0; i < 6 && cursor && !visited.has(cursor); i++) {
    visited.add(cursor);
    try {
      const parent = await getMessage(channelId, cursor);
      replyChain.unshift(parent);
      cursor = parent.referencedMessageId;
    } catch (e) {
      warnings.push(`返信元メッセージの取得に失敗: ${e.message}`);
      break;
    }
  }

  // スレッドなら親チャンネル情報と先頭メッセージ群
  let thread = null;
  if (channel && THREAD_TYPES.has(channel.type)) {
    thread = {
      id: channel.id,
      name: channel.name || null,
      parentId: channel.parent_id || null,
      messageCount: channel.message_count ?? null,
      starterMessage: null,
      firstMessages: [],
    };
    // スレッド開始メッセージの ID はスレッド ID と同じ (親チャンネル側に存在)
    if (channel.parent_id) {
      try {
        thread.starterMessage = await getMessage(channel.parent_id, channel.id);
      } catch {
        /* 開始メッセージが削除されている場合など。無視 */
      }
    }
    try {
      thread.firstMessages = await getThreadMessages(channel.id, 30);
    } catch (e) {
      warnings.push(`スレッドメッセージの取得に失敗: ${e.message}`);
    }
  }

  // 前後のメッセージ (分割送信されたケースを拾う)
  let siblings = [];
  try {
    const around = await getAround(channelId, messageId, 25);
    const tTime = new Date(target.timestamp).getTime();
    siblings = around.filter((m) => {
      if (m.id === messageId) return false;
      if (visited.has(m.id)) return false;
      const sameAuthor = m.author && target.author && m.author.id === target.author.id;
      const near = Math.abs(new Date(m.timestamp).getTime() - tTime) <= 10 * MINUTE;
      return sameAuthor || near;
    });
  } catch (e) {
    warnings.push(`周辺メッセージの取得に失敗: ${e.message}`);
  }

  const byTime = (a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
  replyChain.sort(byTime);
  siblings.sort(byTime);
  if (thread) thread.firstMessages.sort(byTime);

  return {
    type: "discord",
    url: messageUrl({ guildId, channelId, messageId }),
    channel: channel
      ? { id: channel.id, name: channel.name || null, type: channel.type }
      : { id: channelId },
    target,
    replyChain,
    thread,
    siblings,
    warnings,
  };
}
