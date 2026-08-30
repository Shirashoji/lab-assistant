#!/usr/bin/env node
// Google OAuth の同意フローを一度だけ実行し、リフレッシュトークンを取得する。
//
//   1. `.env` に GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を設定
//      (Google Cloud Console → 認証情報 → OAuth クライアント ID → 種類「デスクトップ」)
//   2. node scripts/bin/auth-google.mjs を実行
//   3. 表示された URL をブラウザで開き、Google アカウントで許可
//   4. 表示された GOOGLE_REFRESH_TOKEN=... を `.env` に貼り付け
//      (`--write` を付けると `.env` の該当行を直接書き換える)
//
// Drive 検索 (drive.readonly スコープ) を使うには、このスクリプトの再実行が必要です。
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, PLUGIN_ROOT } from "../lib/config.mjs";

const SCOPE = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.readonly",
].join(" ");

function openBrowser(url) {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  } catch {
    /* ブラウザを開けなくても URL は表示済み */
  }
}

async function main() {
  const clientId = config.googleClientId;
  const clientSecret = config.googleClientSecret;
  if (!clientId || !clientSecret) {
    process.stderr.write(
      "先に .env の GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を設定してください。\n"
    );
    process.exit(2);
  }
  const port = config.oauthRedirectPort;
  const redirectUri = `http://127.0.0.1:${port}`;

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
    });

  const code = await new Promise((resolveCode, rejectCode) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url, redirectUri);
      if (u.pathname !== "/") {
        res.writeHead(404);
        res.end();
        return;
      }
      const err = u.searchParams.get("error");
      const c = u.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<html><body style="font-family:sans-serif;padding:2rem">` +
          (c
            ? "認証が完了しました。ターミナルに戻ってください。"
            : `認証に失敗しました: ${err || "unknown"}`) +
          `</body></html>`
      );
      server.close();
      if (c) resolveCode(c);
      else rejectCode(new Error(err || "認証がキャンセルされました"));
    });
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write(
        `\nブラウザで次の URL を開いて許可してください:\n\n${authUrl}\n\n` +
          `(リダイレクト先: ${redirectUri})\n`
      );
      openBrowser(authUrl.toString());
    });
    server.on("error", rejectCode);
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const token = await tokenRes.json();
  if (!tokenRes.ok || !token.refresh_token) {
    process.stderr.write(
      `トークン取得に失敗しました: ${JSON.stringify(token)}\n` +
        `(refresh_token が返らない場合は、Google アカウントの「サードパーティアクセス」から当該アプリを削除してから再試行してください)\n`
    );
    process.exit(1);
  }

  // 実際に許可されたスコープを出す。Drive が入っていない = 同意画面で
  // drive.readonly が要求されなかった (Cloud Console のスコープ設定漏れ) と分かる。
  const granted = String(token.scope || "").split(/\s+/).filter(Boolean);
  const hasDrive = granted.some((s) => s.includes("/auth/drive"));
  process.stdout.write(
    `\n許可されたスコープ:\n` + granted.map((s) => `  - ${s}\n`).join("")
  );
  if (!hasDrive) {
    process.stderr.write(
      `\n⚠ Drive のスコープが許可されていません。Drive 検索は使えません。\n` +
        `  Google Cloud Console の「OAuth 同意画面」→ スコープに\n` +
        `  https://www.googleapis.com/auth/drive.readonly を追加してから、\n` +
        `  もう一度このスクリプトを実行してください。\n`
    );
  }

  if (process.argv.includes("--write")) {
    const envPath = join(PLUGIN_ROOT, ".env");
    if (!existsSync(envPath)) {
      process.stderr.write(`\n${envPath} が見つからないので書き込めませんでした。\n`);
    } else {
      const line = `GOOGLE_REFRESH_TOKEN=${token.refresh_token}`;
      const before = readFileSync(envPath, "utf8");
      const after = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(before)
        ? before.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line)
        : before.replace(/\n*$/, `\n${line}\n`);
      writeFileSync(envPath, after);
      process.stdout.write(`\n✅ ${envPath} の GOOGLE_REFRESH_TOKEN を更新しました。\n`);
      return;
    }
  }

  process.stdout.write(
    `\n✅ 取得できました。次の行を .env に貼り付けてください` +
      ` (次からは --write で自動更新できます):\n\n` +
      `GOOGLE_REFRESH_TOKEN=${token.refresh_token}\n\n`
  );
}

main().catch((e) => {
  process.stderr.write(`エラー: ${e.message}\n`);
  process.exit(1);
});
