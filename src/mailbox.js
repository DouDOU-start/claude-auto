import tls from "node:tls";
import { getMailTokenByMode } from "./mail-token.js";

const GRAPH_MESSAGES_URL =
  "https://graph.microsoft.com/v1.0/me/messages?$top=20&$orderby=receivedDateTime%20desc&$select=subject,receivedDateTime,from,toRecipients,bodyPreview,body";

export function parseMailAccountLine(line) {
  const [email, password, clientId, ...refreshParts] = String(line || "").trim().split("----");
  const refreshToken = refreshParts.join("----");
  if (!email || !password || !clientId || !refreshToken) {
    throw new Error("Mail account line must use: email----password----client_id----refresh_token");
  }
  return { email, password, clientId, refreshToken };
}

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
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const result = await tryReadClaudeMagicLink({ account, since });
      if (result.magicLink) return result;
      log(`No Claude magic link yet. Mode=${result.mode || "unknown"}. Waiting ${intervalMs}ms...`);
    } catch (error) {
      lastError = error;
      log(`Mail poll failed: ${error.message}`);
    }
    await wait(intervalMs);
  }

  throw new Error(`Claude magic link not found before timeout.${lastError ? ` Last error: ${lastError.message}` : ""}`);
}

export async function tryReadClaudeMagicLink({ account, since }) {
  const graph = await tryReadGraphMagicLink({ account, since });
  if (graph.magicLink || graph.tokenOk) return graph;

  const imap = await tryReadImapMagicLink({ account, since });
  return imap;
}

async function tryReadGraphMagicLink({ account, since }) {
  const tokenResults = [];
  for (const mode of ["new-gr", "old-gr"]) {
    try {
      const token = await getMailTokenByMode({
        refreshToken: account.refreshToken,
        clientId: account.clientId,
        mode,
      });
      const messages = await readGraphMessages(token.accessToken);
      const match = findMagicLinkInMessages(messages, account.email, since);
      return {
        mode: token.label,
        modeId: token.mode,
        tokenOk: true,
        graphOk: true,
        magicLink: match.magicLink,
        message: match.message,
        checkedMessages: messages.length,
      };
    } catch (error) {
      tokenResults.push(`${mode}: ${error.message}`);
    }
  }
  return {
    mode: "Graph",
    tokenOk: false,
    graphOk: false,
    magicLink: "",
    errors: tokenResults,
  };
}

async function readGraphMessages(accessToken) {
  const response = await fetch(GRAPH_MESSAGES_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
  });
  const data = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) {
    const code = data.error?.code || response.status;
    const message = data.error?.message || data.raw || response.statusText;
    throw new Error(`Graph read failed: ${code} - ${message}`);
  }
  return data.value || [];
}

async function tryReadImapMagicLink({ account, since }) {
  let socket;
  try {
    const token = await getMailTokenByMode({
      refreshToken: account.refreshToken,
      clientId: account.clientId,
      mode: "imap",
    });
    socket = await connectImap();
    const xoauth = Buffer.from(`user=${account.email}\x01auth=Bearer ${token.accessToken}\x01\x01`).toString("base64");
    const auth = await imapCommand(socket, "A1", `AUTHENTICATE XOAUTH2 ${xoauth}`);
    if (!/A1 OK/i.test(auth)) throw new Error("IMAP XOAUTH2 authentication failed.");
    await imapCommand(socket, "A2", "SELECT INBOX");
    const search = await imapCommand(socket, "A3", "UID SEARCH ALL");
    const uidLine = search.split(/\r?\n/).find((line) => /^\* SEARCH/i.test(line)) || "";
    const uids = uidLine.replace(/^\* SEARCH\s*/i, "").trim().split(/\s+/).filter(Boolean).slice(-20);
    if (!uids.length) return { mode: "IMAP", tokenOk: true, imapOk: true, magicLink: "", checkedMessages: 0 };

    const fetchText = await imapCommand(
      socket,
      "A4",
      `UID FETCH ${uids.join(",")} (BODY.PEEK[] FLAGS)`,
      60000,
    );
    await imapCommand(socket, "A5", "LOGOUT", 10000).catch(() => null);

    const magicLink = extractClaudeMagicLink(fetchText, account.email);
    return {
      mode: "IMAP",
      tokenOk: true,
      imapOk: true,
      magicLink,
      checkedMessages: uids.length,
      since: since.toISOString(),
    };
  } catch (error) {
    return {
      mode: "IMAP",
      tokenOk: false,
      imapOk: false,
      magicLink: "",
      error: error.message,
    };
  } finally {
    socket?.end();
  }
}

function findMagicLinkInMessages(messages, email, since) {
  for (const message of messages) {
    const receivedAt = message.receivedDateTime ? new Date(message.receivedDateTime) : null;
    if (receivedAt && receivedAt < since) continue;
    const haystack = [
      message.subject,
      message.bodyPreview,
      message.body?.content,
      message.from?.emailAddress?.address,
    ].filter(Boolean).join("\n");
    if (!/claude|anthropic|magic-link/i.test(haystack)) continue;

    const magicLink = extractClaudeMagicLink(haystack, email);
    if (magicLink) {
      return {
        magicLink,
        message: {
          subject: message.subject || "",
          receivedDateTime: message.receivedDateTime || "",
          from: message.from?.emailAddress?.address || message.from?.emailAddress?.name || "",
        },
      };
    }
  }
  return { magicLink: "", message: null };
}

async function connectImap() {
  const socket = tls.connect({ host: "outlook.office365.com", port: 993, servername: "outlook.office365.com" });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("secureConnect", resolve);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("IMAP greeting timeout")), 15000);
    socket.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  return socket;
}

function imapCommand(socket, tag, command, timeoutMs = 30000) {
  let buffer = "";
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => cleanup(new Error(`IMAP timeout: ${tag}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (
        buffer.includes(`\r\n${tag} OK`) ||
        buffer.startsWith(`${tag} OK`) ||
        buffer.includes(`\r\n${tag} NO`) ||
        buffer.includes(`\r\n${tag} BAD`)
      ) {
        cleanup(null, buffer);
      }
    };
    const cleanup = (error, value) => {
      clearTimeout(timer);
      socket.off("data", onData);
      if (error) reject(error);
      else resolve(value);
    };
    socket.on("data", onData);
    socket.write(`${tag} ${command}\r\n`);
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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
