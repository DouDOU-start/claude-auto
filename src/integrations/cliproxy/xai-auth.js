import { randomBytes } from "node:crypto";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const XAI_API_BASE_URL = "https://api.x.ai/v1";

export function buildCliProxyXaiAuth(token, {
  now = new Date(),
  tokenEndpoint = token?.token_endpoint || "https://auth.x.ai/oauth2/token",
} = {}) {
  if (!token?.access_token) throw new Error("CLIProxy xAI 认证缺少 access_token。");
  const timestamp = now.toISOString();
  const expiresIn = Number(token.expires_in || 0);
  const auth = {
    type: "xai",
    access_token: String(token.access_token),
    refresh_token: String(token.refresh_token || ""),
    id_token: String(token.id_token || ""),
    token_type: String(token.token_type || "Bearer"),
    expires_in: expiresIn,
    expired: expiresIn > 0
      ? new Date(now.getTime() + expiresIn * 1000).toISOString()
      : "",
    last_refresh: timestamp,
    base_url: XAI_API_BASE_URL,
    token_endpoint: String(tokenEndpoint),
    auth_kind: "oauth",
    disabled: false,
  };
  if (token.email) auth.email = String(token.email).trim();
  if (token.sub) auth.sub = String(token.sub).trim();
  return auth;
}

export function cliProxyXaiCredentialFileName(email, subject = "", now = Date.now()) {
  const identity = sanitizeFileSegment(email) || sanitizeFileSegment(subject) || String(now);
  return `xai-${identity}.json`;
}

export async function writeCliProxyXaiAuth(token, {
  projectRoot,
  authDir = "exports/cliproxy",
  now = new Date(),
} = {}) {
  if (!projectRoot) throw new Error("生成 CLIProxy 认证文件时缺少项目根目录。");
  const directory = resolve(projectRoot, authDir);
  const auth = buildCliProxyXaiAuth(token, { now });
  const fileName = cliProxyXaiCredentialFileName(auth.email, auth.sub, now.getTime());
  const outputPath = join(directory, fileName);
  const temporaryPath = join(
    directory,
    `.${fileName}.${randomBytes(4).toString("hex")}.tmp`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, outputPath);
    await chmod(outputPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  const fileMode = (await stat(outputPath)).mode & 0o777;
  return {
    outputPath,
    fileName,
    email: auth.email || "",
    subject: auth.sub || "",
    expired: auth.expired,
    permissionsRestricted: (fileMode & 0o077) === 0,
  };
}

function sanitizeFileSegment(value) {
  const normalized = String(value || "").trim();
  let result = "";
  for (const character of normalized) {
    result += /[a-zA-Z0-9@._-]/.test(character) ? character : "-";
  }
  return result.replace(/^-+|-+$/g, "");
}
