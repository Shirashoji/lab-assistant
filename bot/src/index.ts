import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import { config } from "./config.js";
import { runAgent } from "./runAgent.js";

const ESA_URL_RE = /https?:\/\/[a-z0-9-]+\.esa\.io\/posts\/\d+[^\s<>()"']*/gi;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel],
});

client.once(Events.ClientReady, (c) => {
  console.log(`ログイン: ${c.user.tag}`);
  console.log(
    config.allowedGuildIds.length
      ? `応答対象ギルド: ${config.allowedGuildIds.join(", ")}`
      : "応答対象ギルド: 全て"
  );
});

function esaUrlsIn(text: string | null | undefined): string[] {
  if (!text) return [];
  return [...text.matchAll(ESA_URL_RE)].map((m) => m[0]);
}

async function collectTargetUrls(message: Message): Promise<string[]> {
  const urls = new Set<string>();

  // 返信先メッセージ
  if (message.reference?.messageId) {
    const ref = await message
      .fetchReference()
      .catch(() => null as Message | null);
    if (message.guildId && message.channelId && message.reference.messageId) {
      urls.add(
        `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.reference.messageId}`
      );
    }
    for (const u of esaUrlsIn(ref?.content)) urls.add(u);
  }

  // トリガーメッセージ本文中の URL (esa と Discord メッセージリンク)
  for (const u of esaUrlsIn(message.content)) urls.add(u);
  const discordLink =
    /https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/channels\/\d+\/\d+\/\d+/gi;
  for (const m of message.content.matchAll(discordLink)) urls.add(m[0]);

  return [...urls];
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!client.user || !message.mentions.users.has(client.user.id)) return;
    if (
      config.allowedGuildIds.length &&
      (!message.guildId || !config.allowedGuildIds.includes(message.guildId))
    ) {
      return;
    }

    const urls = await collectTargetUrls(message);
    if (urls.length === 0) {
      await message.reply(
        "予定の元になる Discord メッセージ（返信）か esa リンクが見つかりませんでした。予定メッセージに返信する形で、私にメンションしてください。"
      );
      return;
    }

    if ("sendTyping" in message.channel) {
      await message.channel.sendTyping().catch(() => {});
    }
    console.log(`[${message.guildId}] 処理開始: ${urls.join(" , ")}`);

    const reply = await runAgent(urls);
    for (const chunk of splitForDiscord(reply)) {
      await message.reply(chunk);
    }
  } catch (err) {
    console.error(err);
    await message
      .reply(`エラーが発生しました: ${(err as Error).message}`)
      .catch(() => {});
  }
});

function splitForDiscord(text: string, limit = 1900): string[] {
  if (text.length <= limit) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

client.login(config.discordToken);
