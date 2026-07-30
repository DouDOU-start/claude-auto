import {
  XAI_ACCOUNTS_ORIGIN,
  XAI_DEVICE_FLOW_RETRIES,
} from "./constants.js";

export function parseJwtIdentity(token) {
  const claims = parseJwtClaims(token);
  return {
    email: typeof claims.email === "string" ? claims.email.trim() : "",
    sub: typeof claims.sub === "string" ? claims.sub.trim() : "",
  };
}

export function parseJwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function principalIdFromSso(sso) {
  const claims = parseJwtClaims(sso);
  for (const key of ["sub", "principal_id", "principalId", "user_id", "userId", "uid"]) {
    if (claims[key] !== undefined && String(claims[key]).trim()) {
      return String(claims[key]).trim();
    }
  }
  for (const parent of ["user", "account", "identity", "profile"]) {
    const nested = claims[parent];
    if (!nested || typeof nested !== "object") continue;
    for (const key of ["sub", "principal_id", "user_id", "userId", "uid"]) {
      if (nested[key] !== undefined && String(nested[key]).trim()) {
        return String(nested[key]).trim();
      }
    }
  }
  return "";
}

export function parseHtmlFormFields(html) {
  const fields = {};
  for (const match of String(html || "").matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = htmlAttribute(tag, "name");
    if (!name || /^submit$/i.test(name)) continue;
    fields[name] = htmlAttribute(tag, "value");
  }
  return fields;
}

export function xaiDeviceFormHeaders(referer) {
  return {
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: XAI_ACCOUNTS_ORIGIN,
    Referer: referer || `${XAI_ACCOUNTS_ORIGIN}/`,
    "Sec-Fetch-Site": "same-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };
}

export function responseText(response) {
  if (typeof response?.body === "string") return response.body;
  if (typeof response?.rawBody === "string") return response.rawBody;
  return "";
}

export function responseLocation(response, baseUrl) {
  const location = headerValue(response?.headers, "location");
  if (!location) return "";
  try {
    return new URL(location, baseUrl).href;
  } catch {
    return "";
  }
}

export function headerValue(headers, name) {
  return headerValues(headers, name)[0] || "";
}

export function headerValues(headers, name) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function" && name.toLowerCase() === "set-cookie") {
    return headers.getSetCookie().map(String);
  }
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return value === null || value === undefined ? [] : [String(value)];
  }
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  if (!entry) return [];
  return Array.isArray(entry[1]) ? entry[1].map(String) : [String(entry[1])];
}

export function mergeHeaders(primary, secondary) {
  const result = {};
  for (const source of [primary || {}, secondary || {}]) {
    for (const [name, value] of Object.entries(source)) {
      const existing = Object.keys(result).find((key) => key.toLowerCase() === name.toLowerCase());
      if (existing) delete result[existing];
      if (value !== undefined && value !== null && value !== "") result[name] = String(value);
    }
  }
  return result;
}

export function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

export function isSignInUrl(url) {
  return /sign-in|sign-up/.test(String(url || "").toLowerCase());
}

export function isBareAccountUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "").toLowerCase();
    return (path === "/account" || path === "/accounts") && !/device|consent|oauth2/.test(url);
  } catch {
    return false;
  }
}

export function oauthLocationError(url) {
  try {
    return new URL(url).searchParams.get("error") || "";
  } catch {
    return "";
  }
}

export function isDeviceAuthorizationDone(url) {
  const value = String(url || "").toLowerCase();
  return /\/oauth2\/device\/done|\/device\/done|device_authorized/.test(value) &&
    !oauthLocationError(value);
}

export function isAuthorizedBody(body) {
  return /设备已授权|device (?:is )?authorized|you have authorized|authorization complete/i.test(
    String(body || ""),
  );
}

export function isConsentPage(url, body = "") {
  return /consent|device\/verify|device\/approve|authorize grok|wants to access|请求访问/i.test(
    `${url}\n${body}`,
  );
}

export function isRateLimitedResponse(response, url = "") {
  const body = typeof response?.body === "string"
    ? response.body
    : JSON.stringify(response?.body || {});
  return /slow_down|rate_limited|rate limit|too many|\b429\b/i.test(
    `${response?.status || ""} ${url} ${body}`,
  );
}

export function isBrowserBlockedResponse(response) {
  return Number(response?.status) === 403 &&
    /sorry, you have been blocked|attention required|cloudflare ray id/i.test(responseText(response));
}

export function requiresBrowserApproval(error) {
  return [
    "browser_required",
    "browser_blocked",
    "browser_navigation_failed",
  ].includes(String(error?.oauthError || ""));
}

export function oauthProtocolError(message, oauthError = "", status = 0) {
  const error = new Error(message);
  error.oauthError = String(oauthError || "");
  error.oauthStatus = Number(status || 0);
  return error;
}

export function isRetryableDeviceFlowError(error, {
  approvalMethod = "protocol",
} = {}) {
  if (error?.oauthError === "invalid_grant") return approvalMethod !== "browser";
  if ([
    "rate_limited",
    "slow_down",
    "verify_failed",
    "approval_incomplete",
    "browser_required",
    "browser_blocked",
    "browser_navigation_failed",
    "browser_verify_failed",
    "browser_approval_failed",
    "browser_timeout",
  ].includes(error?.oauthError)) {
    return true;
  }
  if (Number(error?.oauthStatus) === 429 || Number(error?.oauthStatus) >= 500) return true;
  return /超时|timeout|network|socket|ECONN|重置|连接|temporary/i.test(
    String(error?.message || error),
  );
}

export function normalizeDeviceFlowRetries(retries) {
  return Math.max(1, Math.min(6, Number(retries) || XAI_DEVICE_FLOW_RETRIES));
}

export function deviceFlowBackoffMs(attempt) {
  return Math.max(1000, Math.min(20000, Number(attempt || 1) * 2000));
}

export function fastPollIntervalMs(intervalSeconds) {
  const hinted = Number(intervalSeconds || 1) * 1000;
  return Math.max(400, Math.min(1500, Number.isFinite(hinted) ? hinted : 1000));
}

export function validateXaiOAuthEndpoint(value, field = "endpoint") {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error(`xAI OAuth ${field} 地址无效。`);
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== "https:" ||
    (hostname !== "x.ai" && !hostname.endsWith(".x.ai"))
  ) {
    throw new Error(`xAI OAuth ${field} 必须使用 x.ai 的 HTTPS 地址。`);
  }
  return parsed.href;
}

function htmlAttribute(tag, name) {
  const match = String(tag).match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return decodeHtmlEntities(match?.[1] || "");
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
