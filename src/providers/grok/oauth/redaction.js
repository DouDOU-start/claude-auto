import { createHash } from "node:crypto";

export function emitOAuthTrace(trace, action, detail = {}) {
  try {
    trace({
      at: new Date().toISOString(),
      action,
      ...detail,
    });
  } catch {}
}

export function isXaiRelatedURL(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "x.ai" || host.endsWith(".x.ai") ||
      host === "grok.com" || host.endsWith(".grok.com");
  } catch {
    return false;
  }
}

export function redactOAuthURL(raw) {
  if (!raw) return "";
  try {
    const parsed = new URL(String(raw));
    for (const key of [...parsed.searchParams.keys()]) {
      if (/code|token|state|session|challenge/i.test(key)) {
        parsed.searchParams.set(key, "[已脱敏]");
      }
    }
    return parsed.toString();
  } catch {
    return sanitizeOAuthText(raw);
  }
}

export function sanitizeOAuthHeaders(headers = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    result[key] = /authorization|cookie|token|signature|challenge/i.test(key)
      ? "[已脱敏]"
      : sanitizeOAuthText(String(value));
  }
  return result;
}

export function sanitizeOAuthFormText(value) {
  if (!value) return "";
  try {
    const params = new URLSearchParams(value);
    for (const key of [...params.keys()]) {
      if (/code|token|state|session|challenge/i.test(key)) {
        params.set(key, "[已脱敏]");
      }
    }
    return params.toString();
  } catch {
    return sanitizeOAuthText(value);
  }
}

export function sanitizeOAuthValue(value, key = "") {
  if (/access_token|refresh_token|id_token|device_code|user_code|code_verifier|code_challenge|cookie|sso/i.test(key)) {
    return "[已脱敏]";
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeOAuthValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, item]) => [
        itemKey,
        sanitizeOAuthValue(item, itemKey),
      ]),
    );
  }
  return typeof value === "string" ? sanitizeOAuthText(value) : value;
}

export function oauthFingerprints(value) {
  const result = {};
  const collect = (item, key = "") => {
    if (item === undefined || item === null) return;
    if (Array.isArray(item)) {
      for (const child of item) collect(child);
      return;
    }
    if (typeof item === "object") {
      for (const [childKey, child] of Object.entries(item)) collect(child, childKey);
      return;
    }
    const text = String(item);
    if (/^(?:user_code|device_code)$/i.test(key) && text) {
      result[key.toLowerCase()] = oauthFingerprint(text);
      return;
    }
    if (typeof item !== "string") return;
    try {
      const parsed = new URL(item);
      for (const name of ["user_code", "device_code"]) {
        const secret = parsed.searchParams.get(name);
        if (secret) result[name] = oauthFingerprint(secret);
      }
    } catch {}
    try {
      const params = new URLSearchParams(item);
      for (const name of ["user_code", "device_code"]) {
        const secret = params.get(name);
        if (secret) result[name] = oauthFingerprint(secret);
      }
    } catch {}
  };
  collect(value);
  return result;
}

export function sanitizeOAuthText(value) {
  return String(value || "")
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi, "[设备码已脱敏]")
    .replace(/((?:access|refresh|id|device)[_-]?token["'=:\s]+)[^\s"'&]+/gi, "$1[已脱敏]")
    .replace(/((?:user_code|device_code|code|state)=)[^&\s]+/gi, "$1[已脱敏]")
    .slice(0, 4000);
}

function oauthFingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}
