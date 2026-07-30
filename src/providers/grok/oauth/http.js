import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { throwIfAborted } from "../../../core/abort.js";
import { HTTP_TIMEOUT_MS } from "./constants.js";
import {
  headerValues,
  isRedirectStatus,
  mergeHeaders,
  responseLocation,
  validateXaiOAuthEndpoint,
} from "./utils.js";

export function createCookieSession({ initialCookies, proxyUrl, signal, request }) {
  const sharedCookies = new Map(Object.entries(initialCookies || {}));
  const scopedCookies = new Map();
  return {
    cookie(name) {
      if (sharedCookies.has(name)) return sharedCookies.get(name) || "";
      return [...scopedCookies.values()].find((cookie) => cookie.name === name)?.value || "";
    },
    async request(url, options = {}) {
      let currentUrl = validateXaiOAuthEndpoint(url);
      let method = String(options.method || "GET").toUpperCase();
      let form = options.form;
      const followRedirects = Boolean(options.followRedirects);
      for (let redirectCount = 0; redirectCount <= 8; redirectCount += 1) {
        throwIfAborted(signal);
        const headers = mergeHeaders(options.headers, {
          Cookie: cookieHeaderForUrl(sharedCookies, scopedCookies, currentUrl),
        });
        const response = await request(currentUrl, {
          method,
          form,
          headers,
          proxyUrl,
          signal,
          responseType: "text",
        });
        absorbSetCookies(scopedCookies, response.headers, currentUrl);
        response.url = response.url || currentUrl;
        if (!followRedirects || !isRedirectStatus(response.status)) return response;
        const nextUrl = responseLocation(response, currentUrl);
        if (!nextUrl) return response;
        currentUrl = validateXaiOAuthEndpoint(nextUrl, "redirect_uri");
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) && method === "POST")
        ) {
          method = "GET";
          form = undefined;
        }
      }
      throw new Error("xAI OAuth 页面重定向次数过多。");
    },
  };
}

export function selectCookie(cookies, name) {
  const matches = cookies.filter(
    (cookie) => cookie?.name === name && String(cookie.value || "").trim(),
  );
  return matches.find((cookie) =>
    /(?:^|\.)x\.ai$/i.test(String(cookie.domain || "").replace(/^\./, ""))
  ) || matches[0];
}

export function oauthHttpRequest(url, {
  method = "GET",
  form,
  headers: customHeaders,
  proxyUrl = "",
  signal,
  timeoutMs = HTTP_TIMEOUT_MS,
  responseType = "json",
} = {}) {
  const target = new URL(validateXaiOAuthEndpoint(url));
  const body = form ? new URLSearchParams(form).toString() : "";
  const headers = mergeHeaders({
    Accept: "application/json",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36",
  }, customHeaders);
  if (body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    headers["Content-Length"] = Buffer.byteLength(body);
  }
  const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      agent,
      signal,
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          request.destroy(new Error("xAI OAuth 响应体过大。"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        agent?.destroy();
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (responseType === "text") {
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: raw,
            rawBody: raw,
            url: target.href,
          });
          return;
        }
        try {
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: raw ? JSON.parse(raw) : {},
            rawBody: raw,
            url: target.href,
          });
        } catch {
          reject(new Error("xAI OAuth 响应不是有效 JSON。"));
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("xAI OAuth 请求超时。")));
    request.once("error", (error) => {
      agent?.destroy();
      reject(error);
    });
    if (body) request.write(body);
    request.end();
  });
}

function absorbSetCookies(cookies, headers, responseUrl) {
  const values = headerValues(headers, "set-cookie");
  const response = new URL(responseUrl);
  for (const value of values) {
    const parts = String(value || "").split(";").map((part) => part.trim());
    const pair = parts.shift() || "";
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const cookieValue = pair.slice(separator + 1).trim();
    if (!name) continue;
    const attributes = Object.fromEntries(parts.map((part) => {
      const index = part.indexOf("=");
      return index === -1
        ? [part.toLowerCase(), true]
        : [part.slice(0, index).trim().toLowerCase(), part.slice(index + 1).trim()];
    }));
    const hostOnly = !attributes.domain;
    const domain = String(attributes.domain || response.hostname).replace(/^\./, "").toLowerCase();
    const path = String(attributes.path || "/");
    const key = `${domain}\t${path}\t${name}`;
    const maxAge = Number(attributes["max-age"]);
    const expiresAt = attributes.expires ? Date.parse(String(attributes.expires)) : Number.NaN;
    const expired = !cookieValue ||
      (Number.isFinite(maxAge) && maxAge <= 0) ||
      (Number.isFinite(expiresAt) && expiresAt <= Date.now());
    if (expired) {
      cookies.delete(key);
      continue;
    }
    cookies.set(key, {
      name,
      value: cookieValue,
      domain,
      path,
      hostOnly,
      secure: Boolean(attributes.secure),
    });
  }
}

function cookieHeaderForUrl(sharedCookies, scopedCookies, url) {
  const target = new URL(url);
  const selected = new Map(sharedCookies);
  for (const cookie of scopedCookies.values()) {
    const domainMatches = cookie.hostOnly
      ? target.hostname === cookie.domain
      : target.hostname === cookie.domain || target.hostname.endsWith(`.${cookie.domain}`);
    if (!domainMatches || !target.pathname.startsWith(cookie.path)) continue;
    if (cookie.secure && target.protocol !== "https:") continue;
    selected.set(cookie.name, cookie.value);
  }
  return [...selected.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

class HttpsProxyAgent extends https.Agent {
  constructor(proxyUrl) {
    super({ keepAlive: false });
    const parsed = new URL(proxyUrl);
    if (parsed.protocol !== "http:") {
      throw new Error("xAI OAuth 当前只支持 HTTP 本地代理桥。");
    }
    this.proxy = parsed;
  }

  createConnection(options, callback) {
    const host = String(options.servername || options.host || options.hostname || "");
    const port = Number(options.port || 443);
    const socket = net.connect({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
    });
    let buffer = Buffer.alloc(0);
    let completed = false;
    const finish = (error, connection) => {
      if (completed) return;
      completed = true;
      if (error) socket.destroy();
      callback(error, connection);
    };
    socket.setTimeout(15000, () => finish(new Error("xAI OAuth 代理隧道连接超时。")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`,
        "latin1",
      );
    });
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      const firstLine = buffer.slice(0, buffer.indexOf("\r\n")).toString("latin1");
      if (!/^HTTP\/1\.[01] 200\b/.test(firstLine)) {
        finish(new Error(`xAI OAuth 代理隧道建立失败：${firstLine}`));
        return;
      }
      const secureSocket = tls.connect({
        socket,
        servername: host,
        ALPNProtocols: ["http/1.1"],
      });
      secureSocket.once("secureConnect", () => {
        secureSocket.setTimeout(0);
        finish(null, secureSocket);
      });
      secureSocket.once("error", (error) => finish(error));
    };
    socket.on("data", onData);
    return undefined;
  }
}
