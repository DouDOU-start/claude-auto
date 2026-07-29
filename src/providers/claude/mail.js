import { pollVerificationMessage } from "../../mail/poller.js";
import { tryReadOutlookVerification } from "../../mail/outlook.js";

export function extractClaudeMagicLink(text, expectedEmail = "") {
  const candidates = [...candidateTexts(text)]
    .flatMap((value) => [...value.matchAll(/https:\/\/claude\.ai\/magic-link#[^"'<>\s)]+/gi)])
    .map((match) => cleanupMagicLink(match[0]));

  for (const candidate of candidates) {
    if (!expectedEmail || magicLinkMatchesEmail(candidate, expectedEmail)) return candidate;
  }
  return "";
}

export async function pollClaudeMagicLink({
  account,
  since = new Date(Date.now() - 5 * 60 * 1000),
  timeoutMs = 180000,
  intervalMs = 5000,
  log = () => {},
  signal,
}) {
  const result = await pollVerificationMessage({
    providerName: "Claude",
    timeoutMs,
    intervalMs,
    log,
    signal,
    tryRead: () => tryReadClaudeMagicLink({ account, since, signal }),
  });
  return { ...result, magicLink: result.verificationUrl };
}

export async function tryReadClaudeMagicLink({ account, since, signal }) {
  const result = await tryReadOutlookVerification({
    account,
    since,
    extractVerification: extractClaudeMagicLink,
    signal,
  });
  return { ...result, magicLink: result.verificationUrl };
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

function cleanupMagicLink(value) {
  return decodeHtmlEntities(value)
    .replace(/=+$/g, (match) => (match.length > 2 ? "==" : match))
    .replace(/=3D/gi, "=")
    .replace(/&amp;/gi, "&")
    .trim();
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

function magicLinkMatchesEmail(url, expectedEmail) {
  try {
    const parsed = new URL(url);
    const encodedEmail = parsed.hash.split(":")[1] || "";
    if (!encodedEmail) return true;
    const decoded = Buffer.from(encodedEmail, "base64").toString("utf8");
    return decoded.toLowerCase() === expectedEmail.toLowerCase();
  } catch {
    return false;
  }
}
