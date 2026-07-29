import { pathToFileURL } from "node:url";

const MODES = [
  {
    mode: "new-gr",
    label: "新GR",
    scope: "User.Read Mail.Read offline_access",
    required: false,
  },
  {
    mode: "old-gr",
    label: "老GR",
    scope: "https://graph.microsoft.com/.default",
    required: false,
  },
  {
    mode: "imap",
    label: "IMAP",
    scope: "https://outlook.office.com/IMAP.AccessAsUser.All offline_access",
    required: true,
  },
];

const TOKEN_ENDPOINT = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

if (isCliEntry()) {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.refreshToken || !args.clientId) {
    printHelp();
    return;
  }

  const result = args.mode
    ? await getMailTokenByMode({
        refreshToken: args.refreshToken,
        clientId: args.clientId,
        mode: args.mode,
      })
    : await autoGetMailToken({
        refreshToken: args.refreshToken,
        clientId: args.clientId,
      });

  console.log(JSON.stringify({
    mode: result.label,
    modeId: result.mode,
    scope: result.scope,
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
    tokenType: result.tokenType,
  }, null, 2));
}

export async function autoGetMailToken({ refreshToken, clientId }) {
  let lastError = null;
  for (const mode of MODES) {
    try {
      return await requestMailToken({ refreshToken, clientId, mode });
    } catch (error) {
      lastError = error;
      if (mode.required) throw error;
    }
  }
  throw lastError || new Error("所有邮件令牌模式均失败。");
}

export async function autoGetMail(refresh_token, client_id) {
  let token = await getNewGRToken(refresh_token, client_id);
  if (token) return { mode: "新GR", token };

  token = await getOldGRToken(refresh_token, client_id);
  if (token) return { mode: "老GR", token };

  token = await getImapToken(refresh_token, client_id);
  return { mode: "IMAP", token };
}

export async function getMailTokenByMode({ refreshToken, clientId, mode }) {
  const selected = findMode(mode);
  return requestMailToken({ refreshToken, clientId, mode: selected });
}

export async function getNewGRToken(refreshToken, clientId) {
  try {
    return (await getMailTokenByMode({ refreshToken, clientId, mode: "new-gr" })).accessToken;
  } catch {
    return null;
  }
}

export async function getOldGRToken(refreshToken, clientId) {
  try {
    return (await getMailTokenByMode({ refreshToken, clientId, mode: "old-gr" })).accessToken;
  } catch {
    return null;
  }
}

export async function getImapToken(refreshToken, clientId) {
  return (await getMailTokenByMode({ refreshToken, clientId, mode: "imap" })).accessToken;
}

async function requestMailToken({ refreshToken, clientId, mode }) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: mode.scope,
    }),
  });

  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || !data.access_token) {
    throw new Error(formatTokenError({ mode, response, data }));
  }

  return {
    mode: mode.mode,
    label: mode.label,
    scope: mode.scope,
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    raw: data,
  };
}

function formatTokenError({ mode, response, data }) {
  const code = data.error || response.status;
  const description = data.error_description || data.raw || response.statusText || "令牌请求失败";
  return `${mode.label} 令牌失败：${code} - ${description}`;
}

function findMode(value) {
  const normalized = String(value || "").toLowerCase();
  const mode = MODES.find((item) => item.mode === normalized || item.label.toLowerCase() === normalized);
  if (!mode) {
    throw new Error(`未知模式：${value}。请使用 new-gr、old-gr 或 imap。`);
  }
  return mode;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) args[key] = true;
      else {
        args[key] = value;
        i += 1;
      }
    }
  }
  return args;
}

function isCliEntry() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

function printHelp() {
  console.log(`
用法：
  node src/mail-token.js --refresh-token <refreshToken> --client-id <clientId> [options]

选项：
  --refresh-token <值>     必填，Microsoft 刷新令牌。
  --client-id <值>         必填，Microsoft OAuth 客户端 ID。
  --mode <模式>            可选：new-gr、old-gr 或 imap，默认自动兜底。
  --help                   显示帮助。

自动兜底顺序：
  1. new-gr: User.Read Mail.Read offline_access
  2. old-gr: https://graph.microsoft.com/.default
  3. imap:   https://outlook.office.com/IMAP.AccessAsUser.All offline_access

示例：
  node src/mail-token.js --refresh-token "..." --client-id "..."
  node src/mail-token.js --refresh-token "..." --client-id "..." --mode imap
`);
}
