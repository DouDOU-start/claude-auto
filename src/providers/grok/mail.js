import { pollVerificationMessage } from "../../mail/poller.js";
import { tryReadOutlookVerification } from "../../mail/outlook.js";
import { normalizeGrokVerificationCode } from "./login.js";

export function extractGrokVerificationCode(text) {
  for (const candidate of candidateTexts(text)) {
    const labelPattern =
      /one[\s-]?time(?:\s+security)?\s+code|verification\s+code|security\s+code|邮箱安全码|验证码/gi;
    for (const label of candidate.matchAll(labelPattern)) {
      const nearbyAfter = candidate.slice(
        label.index + label[0].length,
        label.index + label[0].length + 160,
      );
      const nearbyBefore = candidate.slice(Math.max(0, label.index - 160), label.index);
      const value = findCode(nearbyAfter) || findCode(nearbyBefore) || "";
      const code = normalizeGrokVerificationCode(value);
      if (/^[A-Z0-9]{6}$/.test(code)) return code;
    }
  }
  return "";
}

function findCode(value) {
  return (
    String(value).match(/\b([A-Za-z0-9]{3}-[A-Za-z0-9]{3})\b/)?.[1] ||
    String(value).match(/\b([A-Z0-9]{6})\b/)?.[1] ||
    ""
  );
}

export async function pollGrokVerificationCode({
  account,
  since = new Date(Date.now() - 5 * 60 * 1000),
  timeoutMs = 180000,
  intervalMs = 5000,
  log = () => {},
  signal,
}) {
  return pollVerificationMessage({
    providerName: "Grok",
    timeoutMs,
    intervalMs,
    log,
    signal,
    tryRead: () =>
      tryReadOutlookVerification({
        account,
        since,
        extractVerification: extractGrokVerificationCode,
        signal,
      }),
  });
}

function candidateTexts(text) {
  const raw = String(text || "");
  return new Set([
    raw,
    decodeHtmlEntities(raw),
    decodeQuotedPrintable(raw),
    decodeHtmlEntities(decodeQuotedPrintable(raw)),
  ]);
}

function decodeQuotedPrintable(value) {
  return String(value || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
