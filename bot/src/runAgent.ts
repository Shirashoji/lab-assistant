import { query } from "@anthropic-ai/claude-agent-sdk";
import { config } from "./config.js";

/**
 * lab-assistant の add-event スキルを Claude に実行させ、最終応答テキストを返す。
 */
export async function runAgent(urls: string[]): Promise<string> {
  const prompt =
    `次の URL の内容から Google Calendar に予定を追加してください。` +
    `lab-assistant プラグインの add-event スキルの手順に従ってください。\n\n` +
    `URLs:\n${urls.map((u) => `- ${u}`).join("\n")}\n\n` +
    `重要:\n` +
    `- これは Discord Bot 経由の自動実行です。ユーザーへの対話的確認は省略し、` +
    `抽出できた予定はそのまま重複チェックして作成まで進めてください。\n` +
    `- 日付や時刻がどうしても特定できない場合のみ、その旨を返答に明記してください（作成はしない）。\n` +
    `- 返答は簡潔な日本語で。作成した予定 / 作成済みだった予定それぞれのタイトル・日時・カレンダーリンクを含めてください。`;

  const messages = query({
    prompt,
    options: {
      cwd: config.pluginRoot,
      plugins: [{ type: "local", path: config.pluginRoot }],
      allowedTools: ["Bash", "Read", "Skill"],
      permissionMode: "bypassPermissions",
      maxTurns: 25,
    },
  });

  let finalText = "";
  for await (const m of messages) {
    if (m.type === "result") {
      // SDK バージョンにより text / result のどちらかに入る
      finalText =
        (m as unknown as { text?: string }).text ??
        (m as unknown as { result?: string }).result ??
        "";
    }
  }
  return finalText.trim() || "(応答が空でした)";
}
