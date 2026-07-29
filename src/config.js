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

export function resolveRandomEmailDomain({
  requestedDomain = "",
  projectRoot,
  env = process.env,
  defaultDomain = "example.com",
}) {
  const configuredDomain = readAppConfig(projectRoot).mail?.randomDomain || "";
  const domain =
    requestedDomain || env.APP_RANDOM_EMAIL_DOMAIN || configuredDomain || defaultDomain;
  return normalizeEmailDomain(domain);
}

export function resolveRegistrationProviderId({
  requestedProvider = "",
  projectRoot,
  env = process.env,
  defaultProvider = "claude",
}) {
  const configuredProvider = readAppConfig(projectRoot).registration?.provider || "";
  const provider = String(
    requestedProvider || env.APP_REGISTRATION_PROVIDER || configuredProvider || defaultProvider,
  ).trim().toLowerCase();
  if (!provider || !/^[a-z0-9_-]+$/.test(provider)) {
    throw new Error(`注册服务名称格式无效：${provider}`);
  }
  return provider;
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

function normalizeEmailDomain(value) {
  const domain = String(value || "").trim().replace(/^@+/, "").toLowerCase();
  if (
    !domain ||
    domain.length > 253 ||
    !domain.includes(".") ||
    /[\s/@:?#]/.test(domain) ||
    domain.split(".").some((part) => !part || part.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(part))
  ) {
    throw new Error(`随机邮箱后缀不是有效域名：${value}`);
  }
  return domain;
}
