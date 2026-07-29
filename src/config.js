import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function resolveProxyUrl({ requestedProxy = "", projectRoot, env = process.env }) {
  const configuredProxy = readAppConfig(projectRoot).proxy?.url || "";
  const proxyUrl = requestedProxy || env.APP_PROXY_URL || env.CLAUDE_PROXY_URL || configuredProxy;
  if (!proxyUrl) {
    throw new Error(
      [
        "没有配置上游代理。",
        "请传入 --proxy <代理地址>，",
        "设置 APP_PROXY_URL（或兼容变量 CLAUDE_PROXY_URL），",
        `或创建 ${join(projectRoot, "config", "app.local.json")}。`,
      ].join(" "),
    );
  }
  return proxyUrl;
}

export function maskProxy(proxyUrl) {
  const parsed = new URL(proxyUrl);
  const auth = parsed.username || parsed.password ? "***@" : "";
  return `${parsed.protocol}//${auth}${parsed.hostname}:${parsed.port || 80}`;
}

export function readAppConfig(projectRoot) {
  const path = join(projectRoot, "config", "app.local.json");
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}
