import { readAppConfig } from "../config.js";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT = "medium";

export function loadClaudeConfig({ projectRoot, env = process.env, overrides = {} }) {
  const fileConfig = readAppConfig(projectRoot);
  const providerConfig = fileConfig.providers?.claude ?? fileConfig.claude ?? {};
  const rawSessionKeys =
    overrides.sessionKeys ??
    overrides.sessionKey ??
    env.CLAUDE_SESSION_KEYS ??
    env.CLAUDE_SESSION_KEY ??
    providerConfig.sessionKeys ??
    "";

  return {
    sessionKeys: splitSessionKeys(rawSessionKeys),
    proxyUrl:
      overrides.proxyUrl ??
      overrides.proxy ??
      env.CLAUDE_PROXY_URL ??
      fileConfig.proxy?.url ??
      "",
    browserPath:
      overrides.browserPath ??
      overrides.chrome ??
      env.CLAUDE_BROWSER_PATH ??
      fileConfig.browser?.path ??
      "",
    model: overrides.model ?? env.CLAUDE_MODEL ?? providerConfig.model ?? DEFAULT_MODEL,
    effort: overrides.effort ?? env.CLAUDE_EFFORT ?? providerConfig.effort ?? DEFAULT_EFFORT,
    headless: toBoolean(
      overrides.headless ?? env.CLAUDE_HEADLESS ?? fileConfig.browser?.headless,
      defaultHeadless(env),
    ),
    host: String(overrides.host ?? env.CLAUDE_API_HOST ?? fileConfig.api?.host ?? "127.0.0.1"),
    port: Number(overrides.port ?? env.PORT ?? env.CLAUDE_API_PORT ?? fileConfig.api?.port ?? 8080),
    apiKey: String(overrides.apiKey ?? env.CLAUDE_API_KEY ?? fileConfig.api?.key ?? ""),
  };
}

export function splitSessionKeys(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function defaultHeadless(env) {
  return process.platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
