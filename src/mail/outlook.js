import tls from "node:tls";
import { getMailTokenByMode } from "../mail-token.js";
import { throwIfAborted } from "../core/abort.js";

const GRAPH_MESSAGES_URL =
  "https://graph.microsoft.com/v1.0/me/messages?$top=20&$orderby=receivedDateTime%20desc&$select=subject,receivedDateTime,from,toRecipients,bodyPreview,body";

export async function tryReadOutlookVerification({ account, since, extractVerification, signal }) {
  const graph = await tryReadGraphVerification({ account, since, extractVerification, signal });
  if (graph.verificationUrl || graph.tokenOk) return graph;
  return tryReadImapVerification({ account, since, extractVerification, signal });
}

async function tryReadGraphVerification({ account, since, extractVerification, signal }) {
  const tokenResults = [];
  for (const mode of ["new-gr", "old-gr"]) {
    throwIfAborted(signal);
    try {
      const token = await getMailTokenByMode({
        refreshToken: account.refreshToken,
        clientId: account.clientId,
        mode,
        signal,
      });
      const messages = await readGraphMessages(token.accessToken, signal);
      const match = findVerificationInMessages(messages, account.email, since, extractVerification);
      return {
        mode: token.label,
        modeId: token.mode,
        tokenOk: true,
        graphOk: true,
        verificationUrl: match.verificationUrl,
        message: match.message,
        checkedMessages: messages.length,
      };
    } catch (error) {
      throwIfAborted(signal);
      tokenResults.push(`${mode}: ${error.message}`);
    }
  }
  return {
    mode: "Graph",
    tokenOk: false,
    graphOk: false,
    verificationUrl: "",
    errors: tokenResults,
  };
}

async function readGraphMessages(accessToken, signal) {
  const response = await fetch(GRAPH_MESSAGES_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    signal,
  });
  const data = await response.json().catch(async () => ({ raw: await response.text() }));
  if (!response.ok) {
    const code = data.error?.code || response.status;
    const message = data.error?.message || data.raw || response.statusText;
    throw new Error(`Graph 读取失败：${code} - ${message}`);
  }
  return data.value || [];
}

async function tryReadImapVerification({ account, since, extractVerification, signal }) {
  let socket;
  try {
    throwIfAborted(signal);
    const token = await getMailTokenByMode({
      refreshToken: account.refreshToken,
      clientId: account.clientId,
      mode: "imap",
      signal,
    });
    socket = await connectImap(signal);
    const xoauth = Buffer.from(`user=${account.email}\x01auth=Bearer ${token.accessToken}\x01\x01`).toString("base64");
    const auth = await imapCommand(socket, "A1", `AUTHENTICATE XOAUTH2 ${xoauth}`, 30000, signal);
    if (!/A1 OK/i.test(auth)) throw new Error("IMAP XOAUTH2 认证失败。");
    await imapCommand(socket, "A2", "SELECT INBOX", 30000, signal);
    const search = await imapCommand(socket, "A3", "UID SEARCH ALL", 30000, signal);
    const uidLine = search.split(/\r?\n/).find((line) => /^\* SEARCH/i.test(line)) || "";
    const uids = uidLine.replace(/^\* SEARCH\s*/i, "").trim().split(/\s+/).filter(Boolean).slice(-20);
    if (!uids.length) {
      return { mode: "IMAP", tokenOk: true, imapOk: true, verificationUrl: "", checkedMessages: 0 };
    }

    const fetchText = await imapCommand(
      socket,
      "A4",
      `UID FETCH ${uids.join(",")} (BODY.PEEK[] FLAGS)`,
      60000,
      signal,
    );
    await imapCommand(socket, "A5", "LOGOUT", 10000, signal).catch(() => null);
    return {
      mode: "IMAP",
      tokenOk: true,
      imapOk: true,
      verificationUrl: extractVerification(fetchText, account.email),
      checkedMessages: uids.length,
      since: since.toISOString(),
    };
  } catch (error) {
    throwIfAborted(signal);
    return {
      mode: "IMAP",
      tokenOk: false,
      imapOk: false,
      verificationUrl: "",
      error: error.message,
    };
  } finally {
    socket?.end();
  }
}

function findVerificationInMessages(messages, email, since, extractVerification) {
  for (const message of messages) {
    const receivedAt = message.receivedDateTime ? new Date(message.receivedDateTime) : null;
    if (receivedAt && receivedAt < since) continue;
    const haystack = [
      message.subject,
      message.bodyPreview,
      message.body?.content,
      message.from?.emailAddress?.address,
    ].filter(Boolean).join("\n");
    const verificationUrl = extractVerification(haystack, email);
    if (verificationUrl) {
      return {
        verificationUrl,
        message: {
          subject: message.subject || "",
          receivedDateTime: message.receivedDateTime || "",
          from: message.from?.emailAddress?.address || message.from?.emailAddress?.name || "",
        },
      };
    }
  }
  return { verificationUrl: "", message: null };
}

async function connectImap(signal) {
  const socket = tls.connect({
    host: "outlook.office365.com",
    port: 993,
    servername: "outlook.office365.com",
    signal,
  });
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.once("secureConnect", resolve);
  });
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onData = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        onError(error);
      }
    };
    const timer = setTimeout(() => onError(new Error("IMAP 欢迎消息等待超时。")), 15000);
    socket.once("data", onData);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  return socket;
}

function imapCommand(socket, tag, command, timeoutMs = 30000, signal) {
  throwIfAborted(signal);
  let buffer = "";
  return new Promise((resolve, reject) => {
    let timer = null;
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
    const onError = (error) => cleanup(error);
    const onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        cleanup(error);
      }
    };
    const cleanup = (error, value) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => cleanup(new Error(`IMAP 命令超时：${tag}`)), timeoutMs);
    socket.on("data", onData);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    socket.write(`${tag} ${command}\r\n`);
  });
}
