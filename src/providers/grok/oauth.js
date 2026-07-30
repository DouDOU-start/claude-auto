import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { throwIfAborted, waitWithSignal } from "../../core/abort.js";

export const XAI_OAUTH_DISCOVERY_URL =
  "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
export const XAI_DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 30 * 60 * 1000;
const HTTP_TIMEOUT_MS = 30000;

export async function authorizeXaiDevice(cdp, {
  proxyUrl = "",
  signal,
  updateProgress = () => {},
  request = oauthHttpRequest,
  trace = () => {},
} = {}) {
  updateProgress("正在申请 xAI OAuth 设备授权……");
  emitTrace(trace, "服务发现开始", { url: XAI_OAUTH_DISCOVERY_URL });
  const discovery = await discoverXaiOAuth({ proxyUrl, signal, request });
  emitTrace(trace, "服务发现完成", discovery);
  const deviceCode = await requestXaiDeviceCode({ discovery, proxyUrl, signal, request });
  emitTrace(trace, "设备码申请完成", {
    verification_uri: redactOAuthURL(deviceCode.verification_uri),
    verification_uri_complete: redactOAuthURL(deviceCode.verification_uri_complete),
    interval: Number(deviceCode.interval || 0),
    expires_in: Number(deviceCode.expires_in || 0),
  });
  const verificationUrl = validateXaiOAuthEndpoint(
    deviceCode.verification_uri_complete || deviceCode.verification_uri,
    "verification_uri",
  );

  let releasePendingPoll;
  let authorizationError = null;
  const authorizationSettled = new Promise((resolveAuthorization) => {
    releasePendingPoll = resolveAuthorization;
  });
  let token = null;
  let pollError = null;
  const polling = pollXaiOAuthToken(deviceCode, {
    proxyUrl,
    signal,
    request,
    trace,
    async onAuthorizationPending() {
      emitTrace(trace, "令牌轮询已暂停，等待页面完成授权", {});
      await authorizationSettled;
      if (authorizationError) throw authorizationError;
    },
  }).then(
    (value) => {
      token = value;
      return value;
    },
    (error) => {
      pollError = error;
      return null;
    },
  );

  updateProgress("正在当前浏览器中确认 xAI OAuth 授权……");
  emitTrace(trace, "打开设备授权页", { url: redactOAuthURL(verificationUrl) });
  await cdp.send("Page.navigate", { url: verificationUrl });
  try {
    await driveXaiAuthorizationPage(cdp, {
      userCode: deviceCode.user_code,
      signal,
      shouldStop: () => Boolean(token || pollError),
      trace,
    });
    releasePendingPoll();
  } catch (error) {
    authorizationError = error;
    releasePendingPoll();
    await polling;
    throw error;
  }

  await polling;
  if (pollError) throw pollError;
  if (!token) throw new Error("xAI OAuth 授权完成后没有返回令牌。");
  return {
    ...token,
    token_endpoint: discovery.token_endpoint,
  };
}

export async function discoverXaiOAuth({
  proxyUrl = "",
  signal,
  request = oauthHttpRequest,
} = {}) {
  const response = await request(XAI_OAUTH_DISCOVERY_URL, {
    proxyUrl,
    signal,
  });
  if (response.status !== 200) {
    throw new Error(`xAI OAuth 服务发现失败，HTTP 状态码：${response.status}`);
  }
  return {
    device_authorization_endpoint: validateXaiOAuthEndpoint(
      response.body?.device_authorization_endpoint,
      "device_authorization_endpoint",
    ),
    token_endpoint: validateXaiOAuthEndpoint(
      response.body?.token_endpoint,
      "token_endpoint",
    ),
  };
}

export async function requestXaiDeviceCode({
  discovery,
  proxyUrl = "",
  signal,
  request = oauthHttpRequest,
}) {
  if (!discovery?.device_authorization_endpoint || !discovery?.token_endpoint) {
    throw new Error("xAI OAuth 服务发现结果不完整。");
  }
  const response = await request(discovery.device_authorization_endpoint, {
    method: "POST",
    form: {
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    },
    proxyUrl,
    signal,
  });
  if (response.status !== 200) {
    throw new Error(`xAI OAuth 设备码申请失败，HTTP 状态码：${response.status}`);
  }
  const value = response.body || {};
  if (!value.device_code || !value.user_code) {
    throw new Error("xAI OAuth 设备码响应缺少必要字段。");
  }
  validateXaiOAuthEndpoint(
    value.verification_uri_complete || value.verification_uri,
    "verification_uri",
  );
  return {
    ...value,
    token_endpoint: discovery.token_endpoint,
  };
}

export async function pollXaiOAuthToken(deviceCode, {
  proxyUrl = "",
  signal,
  request = oauthHttpRequest,
  wait = waitWithSignal,
  now = () => Date.now(),
  maxDurationMs = MAX_POLL_DURATION_MS,
  trace = () => {},
  onAuthorizationPending = async () => {},
} = {}) {
  if (!deviceCode?.device_code || !deviceCode?.token_endpoint) {
    throw new Error("xAI OAuth 设备码或令牌端点缺失。");
  }

  let intervalMs = Math.max(
    DEFAULT_POLL_INTERVAL_MS,
    Number(deviceCode.interval || 0) * 1000,
  );
  const expiresInMs = Number(deviceCode.expires_in || 0) * 1000;
  const deadline = now() + Math.min(
    maxDurationMs,
    expiresInMs > 0 ? expiresInMs : maxDurationMs,
  );
  let firstAttempt = true;
  let attempt = 0;
  let transientFailures = 0;

  while (firstAttempt || now() < deadline) {
    throwIfAborted(signal);
    if (!firstAttempt) await wait(intervalMs, signal);
    firstAttempt = false;
    throwIfAborted(signal);
    attempt += 1;
    emitTrace(trace, "令牌轮询请求", { attempt, interval_ms: intervalMs });

    let response;
    try {
      response = await request(deviceCode.token_endpoint, {
        method: "POST",
        form: {
          grant_type: XAI_DEVICE_GRANT_TYPE,
          device_code: deviceCode.device_code,
          client_id: XAI_OAUTH_CLIENT_ID,
        },
        proxyUrl,
        signal,
        timeoutMs: 15000,
      });
      transientFailures = 0;
    } catch (error) {
      transientFailures += 1;
      emitTrace(trace, "令牌轮询网络错误", {
        attempt,
        transient_failures: transientFailures,
        message: String(error.message || error),
      });
      if (transientFailures >= 3) {
        throw new Error(`xAI OAuth 令牌轮询网络失败：${error.message}`);
      }
      continue;
    }
    const value = response.body || {};
    emitTrace(trace, "令牌轮询响应", {
      attempt,
      status: response.status,
      error: String(value.error || ""),
      error_description: String(value.error_description || ""),
      has_access_token: Boolean(value.access_token),
      has_refresh_token: Boolean(value.refresh_token),
    });
    if (value.access_token) {
      const identity = parseJwtIdentity(value.id_token);
      return {
        access_token: String(value.access_token),
        refresh_token: String(value.refresh_token || ""),
        id_token: String(value.id_token || ""),
        token_type: String(value.token_type || "Bearer"),
        expires_in: Number(value.expires_in || 0),
        email: identity.email,
        sub: identity.sub,
      };
    }

    switch (value.error) {
      case "authorization_pending":
        await onAuthorizationPending({ attempt }, signal);
        continue;
      case "slow_down":
        intervalMs += DEFAULT_POLL_INTERVAL_MS;
        continue;
      case "expired_token":
        throw new Error("xAI OAuth 设备码已过期。");
      case "access_denied":
        throw new Error("xAI OAuth 授权已被拒绝。");
      default:
        if (value.error) {
          const description = String(value.error_description || "").trim();
          throw new Error(
            `xAI OAuth 令牌请求失败：${value.error}${description ? `：${description}` : ""}`,
          );
        }
        throw new Error(`xAI OAuth 令牌请求失败，HTTP 状态码：${response.status}`);
    }
  }
  throw new Error("xAI OAuth 设备授权等待超时。");
}

export function parseJwtIdentity(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return { email: "", sub: "" };
  try {
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return {
      email: typeof claims.email === "string" ? claims.email.trim() : "",
      sub: typeof claims.sub === "string" ? claims.sub.trim() : "",
    };
  } catch {
    return { email: "", sub: "" };
  }
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

export function oauthHttpRequest(url, {
  method = "GET",
  form,
  proxyUrl = "",
  signal,
  timeoutMs = HTTP_TIMEOUT_MS,
} = {}) {
  const target = new URL(validateXaiOAuthEndpoint(url));
  const body = form ? new URLSearchParams(form).toString() : "";
  const headers = {
    Accept: "application/json",
  };
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
        try {
          resolve({
            status: response.statusCode || 0,
            body: raw ? JSON.parse(raw) : {},
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

async function driveXaiAuthorizationPage(cdp, {
  userCode,
  signal,
  shouldStop = () => false,
  trace = () => {},
}) {
  const deadline = Date.now() + 180000;
  let lastState = null;
  let lastAction = "";
  let currentHref = "";
  let hrefReadyAt = 0;
  const actedHrefs = new Set();
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    if (shouldStop()) return;
    lastState = await xaiAuthorizationPageState(cdp).catch(() => null);
    if (!lastState) {
      await waitWithSignal(500, signal);
      continue;
    }
    if (lastState.href !== currentHref) {
      emitTrace(trace, "授权页面变化", {
        href: redactOAuthURL(lastState.href),
        title: lastState.title,
        text: redactOAuthText(lastState.text).slice(0, 1000),
      });
    }
    if (lastState.success) return;
    if (lastState.denied) throw new Error("xAI OAuth 授权页面显示授权已拒绝。");
    if (/Invalid action/i.test(lastState.text || "")) {
      throw new Error("xAI OAuth 授权页面提交失败：Invalid action。");
    }
    if (lastState.href !== currentHref) {
      currentHref = lastState.href;
      hrefReadyAt = Date.now() + 1800;
    }
    if (Date.now() < hrefReadyAt) {
      await waitWithSignal(300, signal);
      continue;
    }

    if (lastState.codeInputVisible && !lastState.codeInputValue && userCode) {
      emitTrace(trace, "填写设备码", {});
      await fillVisibleCodeInput(cdp, userCode);
      lastAction = "填写设备码";
      await waitWithSignal(500, signal);
      continue;
    }

    if (actedHrefs.has(lastState.href)) {
      await waitWithSignal(700, signal);
      continue;
    }
    const action = await clickAuthorizationButton(cdp);
    if (action?.clicked) {
      emitTrace(trace, "点击授权按钮", {
        text: action.text,
        forced_action: Boolean(action.forcedAction),
      });
      actedHrefs.add(lastState.href);
      lastAction = action.text;
      await waitWithSignal(1000, signal);
      continue;
    }
    await waitWithSignal(700, signal);
  }

  throwIfAborted(signal);
  throw new Error(
    `xAI OAuth 授权页面等待超时。页面：${JSON.stringify({
      href: lastState?.href || "",
      title: lastState?.title || "",
      text: String(lastState?.text || "").slice(0, 1000),
      lastAction,
    })}`,
  );
}

function emitTrace(trace, action, detail) {
  try {
    trace({
      at: new Date().toISOString(),
      action,
      ...detail,
    });
  } catch {}
}

function redactOAuthURL(value) {
  if (!value) return "";
  try {
    const parsed = new URL(String(value));
    for (const key of [...parsed.searchParams.keys()]) {
      if (/code|token|state|session|challenge/i.test(key)) {
        parsed.searchParams.set(key, "[已脱敏]");
      }
    }
    return parsed.toString();
  } catch {
    return redactOAuthText(value);
  }
}

function redactOAuthText(value) {
  return String(value || "")
    .replace(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/gi, "[设备码已脱敏]")
    .replace(/((?:access|refresh|id|device)[_-]?token["'=:\s]+)[^\s"'&]+/gi, "$1[已脱敏]");
}

function xaiAuthorizationPageState(cdp) {
  return cdp.evaluate(`
    (() => {
      const text = document.body?.innerText || "";
      const input = [...document.querySelectorAll("input")].find((item) => {
        const label = [item.name, item.id, item.placeholder, item.getAttribute("aria-label")]
          .filter(Boolean).join(" ");
        return /code|device/i.test(label) && item.offsetParent !== null;
      });
      return {
        href: location.href,
        title: document.title,
        text: text.slice(0, 4000),
        success: /successfully authorized|authorization complete|device (?:is )?connected|you (?:can|may) (?:now )?close|return to (?:the )?terminal/i.test(text),
        denied: /authorization (?:was )?denied|access denied|request denied/i.test(text),
        codeInputVisible: Boolean(input),
        codeInputValue: input?.value || ""
      };
    })()
  `);
}

async function fillVisibleCodeInput(cdp, value) {
  const result = await cdp.evaluate(`
    (() => {
      const input = [...document.querySelectorAll("input")].find((item) => {
        const label = [item.name, item.id, item.placeholder, item.getAttribute("aria-label")]
          .filter(Boolean).join(" ");
        return /code|device/i.test(label) && item.offsetParent !== null;
      });
      if (!input) return false;
      input.focus();
      return true;
    })()
  `);
  if (!result) return;
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await cdp.send("Input.insertText", { text: String(value) });
}

async function clickAuthorizationButton(cdp) {
  const target = await cdp.evaluate(`
    (() => {
      const allowed = /^(?:authorize|approve|allow|confirm|continue|connect|submit|yes(?:,? (?:authorize|allow|approve))?)$/i;
      const denied = /cancel|deny|decline|go back|sign out/i;
      const buttons = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')];
      const button = buttons.find((item) => {
        const text = (item.innerText || item.value || item.getAttribute("aria-label") || "")
          .replace(/\s+/g, " ").trim();
        const visible = item.offsetParent !== null;
        return visible && !item.disabled && !denied.test(text) && allowed.test(text);
      });
      if (!button) return null;
      const text = (button.innerText || button.value || button.getAttribute("aria-label") || "")
        .replace(/\s+/g, " ").trim();
      let forcedAction = false;
      if (/^(?:authorize|approve|allow|confirm|yes(?:,? (?:authorize|allow|approve))?)$/i.test(text)) {
        const form = button.form || button.closest("form");
        if (form) {
          const actionFields = [...form.elements].filter((item) => item.name === "action");
          for (const field of actionFields) field.value = "allow";
          if (!actionFields.length) {
            const input = document.createElement("input");
            input.type = "hidden";
            input.name = "action";
            input.value = "allow";
            form.appendChild(input);
          }
          forcedAction = true;
        }
      }
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      return {
        text,
        forcedAction,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()
  `);
  if (!target) return { clicked: false, text: "" };
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: "left",
    clickCount: 1,
  });
  return {
    clicked: true,
    text: target.text,
    forcedAction: Boolean(target.forcedAction),
  };
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
    socket.setTimeout(15000, () => finish(new Error("xAI OAuth 代理隧道连接超时。")));
    let buffer = Buffer.alloc(0);
    let completed = false;
    const finish = (error, connection) => {
      if (completed) return;
      completed = true;
      if (error) socket.destroy();
      callback(error, connection);
    };
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
