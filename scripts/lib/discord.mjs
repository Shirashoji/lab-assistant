// Discord REST v10 の薄いラッパと文脈収集。依存ゼロ。
import { config } from "./config.mjs";

const API = "https://discord.com/api/v10";

// スレッド系 channel type
const THREAD_TYPES = new Set([10, 11, 12]);

async function apiGet(path, { retry = 1 } = {}) {
  const token = config.discordToken;
  if (!token) throw new Error("DISCORD_BOT_TOKEN が未設定です");
  const res = await fetch(`${API}${path}`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "calendar-agent (https://github.com/, 0.1.0)",
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
