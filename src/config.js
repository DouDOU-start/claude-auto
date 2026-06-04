import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function resolveProxyUrl({ requestedProxy = "", projectRoot }) {
  const configuredProxy = readProxyConfig(projectRoot).proxyUrl;
  const proxyUrl = requestedProxy || process.env.CLAUDE_PROXY_URL || configuredProxy;
  if (!proxyUrl) {
    throw new Error(
      [
        "No upstream proxy configured.",
        "Pass --proxy <proxy-url>,",
        "set CLAUDE_PROXY_URL,",
        `or create ${join(projectRoot, "config", "proxy.json")}.`,
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

function readProxyConfig(projectRoot) {
  const path = join(projectRoot, "config", "proxy.json");
  if (!existsSync(path)) return {};

  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return {};

  const config = JSON.parse(raw);
  return {
    proxyUrl: config.proxyUrl || config.proxy || "",
  };
}
