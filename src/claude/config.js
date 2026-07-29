import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_EFFORT = "medium";

export function loadClaudeConfig({ projectRoot, env = process.env, overrides = {} }) {
  const fileConfig = readLocalConfig(projectRoot);
  const proxyConfig = readJson(join(projectRoot, "config", "proxy.json"));
  const rawSessionKeys =
    overrides.sessionKeys ??
    overrides.sessionKey ??
    env.CLAUDE_SESSION_KEYS ??
    env.CLAUDE_SESSION_KEY ??
    fileConfig.sessionKeys ??
    fileConfig.sessionKey ??
    fileConfig.session_key ??
    "";

  return {
    sessionKeys: splitSessionKeys(rawSessionKeys),
    proxyUrl:
      overrides.proxyUrl ??
      overrides.proxy ??
      env.CLAUDE_PROXY_URL ??
      fileConfig.proxyUrl ??
      fileConfig.proxy ??
      proxyConfig.proxyUrl ??
      proxyConfig.proxy ??
      "",
    browserPath:
      overrides.browserPath ??
      overrides.chrome ??
      env.CLAUDE_BROWSER_PATH ??
      fileConfig.browserPath ??
      "",
    model: overrides.model ?? env.CLAUDE_MODEL ?? fileConfig.model ?? DEFAULT_MODEL,
    effort: overrides.effort ?? env.CLAUDE_EFFORT ?? fileConfig.effort ?? DEFAULT_EFFORT,
    headless: toBoolean(
      overrides.headless ?? env.CLAUDE_HEADLESS ?? fileConfig.headless,
      defaultHeadless(env),
    ),
    host: String(overrides.host ?? env.CLAUDE_API_HOST ?? fileConfig.host ?? "127.0.0.1"),
    port: Number(overrides.port ?? env.PORT ?? env.CLAUDE_API_PORT ?? fileConfig.port ?? 8080),
    apiKey: String(overrides.apiKey ?? env.CLAUDE_API_KEY ?? fileConfig.apiKey ?? ""),
  };
}

export function splitSessionKeys(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(/[\n,]/);
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

export function parseSimpleYaml(text) {
  const result = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf(":");
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    value = value.replace(/^(["'])(.*)\1$/, "$2");
    result[key] = value;
  }
  return result;
}

function readLocalConfig(projectRoot) {
  const jsonPath = join(projectRoot, "config", "claude.local.json");
  if (existsSync(jsonPath)) return readJson(jsonPath);

  const yamlPath = join(projectRoot, "config", "claude.local.yaml");
  if (!existsSync(yamlPath)) return {};
  return parseSimpleYaml(readFileSync(yamlPath, "utf8"));
}

function readJson(path) {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return !["0", "false", "no", "off"].includes(String(value).toLowerCase());
}

function defaultHeadless(env) {
  return process.platform !== "win32" && !env.DISPLAY && !env.WAYLAND_DISPLAY;
}
