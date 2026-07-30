import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { throwIfAborted, waitWithSignal } from "../../core/abort.js";

export const XAI_OAUTH_DISCOVERY_URL =
  "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
export const XAI_DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

const XAI_OAUTH_ISSUER = "https://auth.x.ai";
const XAI_ACCOUNTS_ORIGIN = "https://accounts.x.ai";
const XAI_DEVICE_FLOW_REFERRER = "grok-build";
const XAI_DEVICE_FLOW_PLAN = "generic";
const XAI_DEVICE_FLOW_RETRIES = 3;
const XAI_DEVICE_FLOW_RETRY_GAP_MS = 1200;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MAX_POLL_DURATION_MS = 30 * 60 * 1000;
const HTTP_TIMEOUT_MS = 30000;
let deviceFlowQueue = Promise.resolve();
let lastDeviceFlowRequestAt = 0;

export async function authorizeXaiDevice(cdp, {
  proxyUrl = "",
  signal,
  updateProgress = () => {},
  request = oauthHttpRequest,
  browserApprove = approveXaiDeviceCodeInBrowser,
  trace = () => {},
  wait = waitWithSignal,
  retries = XAI_DEVICE_FLOW_RETRIES,
} = {}) {
  updateProgress("正在读取 xAI 登录状态……");
  const session = await createXaiSsoSession(cdp, {
    proxyUrl,
    signal,
    request,
    trace,
  });
  const ssoPreflight = await validateXaiSsoSession(session, { signal, trace });
  if (!ssoPreflight.confirmed) {
    updateProgress("xAI 登录态预校验未确认，正在改用当前浏览器自动确认设备授权……");
  }

  updateProgress("正在申请 xAI OAuth 设备授权……");
  emitTrace(trace, "服务发现开始", { url: XAI_OAUTH_DISCOVERY_URL });
  const discovery = await discoverXaiOAuth({ proxyUrl, signal, request });
  emitTrace(trace, "服务发现完成", discovery);

  const totalRetries = Math.max(1, Math.min(6, Number(retries) || XAI_DEVICE_FLOW_RETRIES));
  let preferBrowserApproval = !ssoPreflight.confirmed;
  let lastError = null;
  for (let attempt = 1; attempt <= totalRetries; attempt += 1) {
    throwIfAborted(signal);
    if (attempt > 1) {
      updateProgress(`xAI OAuth 授权正在重试 ${attempt}/${totalRetries}……`);
      await wait(deviceFlowBackoffMs(attempt - 1), signal);
    }

    try {
      const deviceCode = await requestXaiDeviceCode({
        discovery,
        proxyUrl,
        signal,
        request,
        wait,
      });
      emitTrace(trace, "设备码申请完成", {
        attempt,
        verification_uri: redactOAuthURL(deviceCode.verification_uri),
        verification_uri_complete: redactOAuthURL(deviceCode.verification_uri_complete),
        interval: Number(deviceCode.interval || 0),
        expires_in: Number(deviceCode.expires_in || 0),
      });

      updateProgress("正在使用 xAI 登录状态自动确认设备授权……");
      let approvalMethod = preferBrowserApproval ? "browser" : "protocol";
      if (preferBrowserApproval) {
        await browserApprove(cdp, deviceCode, { signal, trace, wait });
      } else {
        try {
          await approveXaiDeviceCode(session, deviceCode, {
            signal,
            trace,
          });
        } catch (error) {
          if (!requiresBrowserApproval(error)) throw error;
          approvalMethod = "browser";
          preferBrowserApproval = true;
          updateProgress("协议页面请求受到限制，正在改用当前浏览器自动确认授权……");
          emitTrace(trace, "切换浏览器授权", {
            attempt,
            reason: String(error?.message || error),
          });
          await browserApprove(cdp, deviceCode, { signal, trace, wait });
        }
      }
      emitTrace(trace, "自动授权完成，开始令牌轮询", {
        attempt,
        method: approvalMethod,
      });
      await wait(1000, signal);
      const token = await pollXaiOAuthToken(deviceCode, {
        proxyUrl,
        signal,
        request,
        trace,
        wait,
        maxDurationMs: 60000,
        initialIntervalMs: fastPollIntervalMs(deviceCode.interval),
      });
      const enriched = await enrichXaiTokenIdentity(token, {
        proxyUrl,
        signal,
        request,
      });
      return {
        ...enriched,
        token_endpoint: discovery.token_endpoint,
      };
    } catch (error) {
      lastError = error;
      if (error?.oauthError === "invalid_grant" && !preferBrowserApproval) {
        preferBrowserApproval = true;
      }
      emitTrace(trace, "设备授权尝试失败", {
        attempt,
        message: String(error?.message || error),
        retryable: isRetryableDeviceFlowError(error),
      });
      if (attempt >= totalRetries || !isRetryableDeviceFlowError(error)) throw error;
    }
  }

  throw lastError || new Error("xAI OAuth 自动授权失败。");
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
  wait = waitWithSignal,
  retries = XAI_DEVICE_FLOW_RETRIES,
}) {
  if (!discovery?.device_authorization_endpoint || !discovery?.token_endpoint) {
    throw new Error("xAI OAuth 服务发现结果不完整。");
  }
  const totalRetries = Math.max(1, Math.min(6, Number(retries) || XAI_DEVICE_FLOW_RETRIES));
  for (let attempt = 1; attempt <= totalRetries; attempt += 1) {
    await waitForDeviceFlowSlot(wait, signal);
    const response = await request(discovery.device_authorization_endpoint, {
      method: "POST",
      form: {
        client_id: XAI_OAUTH_CLIENT_ID,
        scope: XAI_OAUTH_SCOPE,
      },
      proxyUrl,
      signal,
    });
    const value = response.body || {};
    if (response.status === 200) {
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
    if (attempt < totalRetries && isRateLimitedResponse(response)) {
      await wait(deviceFlowBackoffMs(attempt), signal);
      continue;
    }
    const error = new Error(`xAI OAuth 设备码申请失败，HTTP 状态码：${response.status}`);
    error.oauthError = String(value.error || "");
    error.oauthStatus = Number(response.status || 0);
    throw error;
  }
  throw new Error("xAI OAuth 设备码申请失败。");
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
  initialIntervalMs,
} = {}) {
  if (!deviceCode?.device_code || !deviceCode?.token_endpoint) {
    throw new Error("xAI OAuth 设备码或令牌端点缺失。");
  }

  let intervalMs = Number.isFinite(Number(initialIntervalMs))
    ? Math.max(200, Number(initialIntervalMs))
    : Math.max(DEFAULT_POLL_INTERVAL_MS, Number(deviceCode.interval || 0) * 1000);
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
      const idIdentity = parseJwtIdentity(value.id_token);
      const accessIdentity = parseJwtIdentity(value.access_token);
      return {
        access_token: String(value.access_token),
        refresh_token: String(value.refresh_token || ""),
        id_token: String(value.id_token || ""),
        token_type: String(value.token_type || "Bearer"),
        expires_in: Number(value.expires_in || 0),
        email: idIdentity.email || accessIdentity.email,
        sub: idIdentity.sub || accessIdentity.sub,
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
        throw oauthProtocolError("xAI OAuth 设备码已过期。", value.error, response.status);
      case "access_denied":
        throw oauthProtocolError("xAI OAuth 授权已被拒绝。", value.error, response.status);
      default:
        if (value.error) {
          const description = String(value.error_description || "").trim();
          if (
            value.error === "invalid_grant" &&
            /access denied/i.test(description)
          ) {
            throw oauthProtocolError(
              "xAI OAuth 已完成授权确认，但服务端拒绝为该账号签发令牌：invalid_grant：Access denied。该账号可能受到 Device OAuth 授权限制。",
              value.error,
              response.status,
            );
          }
          throw oauthProtocolError(
            `xAI OAuth 令牌请求失败：${value.error}${description ? `：${description}` : ""}`,
            value.error,
            response.status,
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

export async function readXaiSsoCookie(cdp) {
  const result = await cdp.send("Network.getCookies", {
    urls: [
      "https://grok.com/",
      "https://accounts.x.ai/",
      "https://auth.x.ai/",
    ],
  });
  const cookies = Array.isArray(result?.cookies) ? result.cookies : [];
  const ssoCookie = selectCookie(cookies, "sso");
  const ssoRwCookie = selectCookie(cookies, "sso-rw");
  const value = String(ssoCookie?.value || ssoRwCookie?.value || "").trim();
  if (!value) {
    throw new Error("xAI OAuth 自动授权失败：当前浏览器缺少 sso/sso-rw 登录 Cookie。");
  }
  return {
    value,
    ssoValue: String(ssoCookie?.value || value).trim(),
    ssoRwValue: String(ssoRwCookie?.value || value).trim(),
    sourceName: String(ssoCookie?.name || ssoRwCookie?.name || "sso"),
    domain: String(ssoCookie?.domain || ssoRwCookie?.domain || ""),
  };
}

async function createXaiSsoSession(cdp, {
  proxyUrl,
  signal,
  request,
  trace,
}) {
  const sso = await readXaiSsoCookie(cdp);
  emitTrace(trace, "读取 SSO Cookie 完成", {
    cookie_name: sso.sourceName,
    cookie_domain: sso.domain,
  });
  return createCookieSession({
    initialCookies: {
      sso: sso.ssoValue,
      "sso-rw": sso.ssoRwValue,
    },
    proxyUrl,
    signal,
    request,
  });
}

async function validateXaiSsoSession(session, { signal, trace }) {
  try {
    throwIfAborted(signal);
    const response = await session.request(`${XAI_ACCOUNTS_ORIGIN}/`, {
      followRedirects: true,
    });
    const confirmed = response.status < 400 && !isSignInUrl(response.url);
    emitTrace(trace, "SSO 登录态预校验", {
      status: response.status,
      url: redactOAuthURL(response.url),
      confirmed,
    });
    return { confirmed, status: response.status, url: response.url };
  } catch (error) {
    throwIfAborted(signal);
    emitTrace(trace, "SSO 登录态预校验异常", {
      message: String(error?.message || error),
    });
    return { confirmed: false, status: 0, url: "" };
  }
}

async function approveXaiDeviceCode(session, deviceCode, { signal, trace }) {
  const userCode = String(deviceCode?.user_code || "").trim();
  const verificationUrl = validateXaiOAuthEndpoint(
    deviceCode?.verification_uri_complete || deviceCode?.verification_uri,
    "verification_uri",
  );
  if (!userCode) throw new Error("xAI OAuth 设备码响应缺少 user_code。");

  emitTrace(trace, "协议访问设备验证页", {
    url: redactOAuthURL(verificationUrl),
  });
  const verificationPage = await session.request(verificationUrl, { followRedirects: true });
  if (isBrowserBlockedResponse(verificationPage)) {
    throw oauthProtocolError(
      "xAI OAuth 协议访问设备验证页时受到 Cloudflare 限制。",
      "browser_required",
      verificationPage.status,
    );
  }
  throwIfAborted(signal);

  const verifyUrls = [
    `${XAI_OAUTH_ISSUER}/oauth2/device/verify`,
    `${XAI_ACCOUNTS_ORIGIN}/oauth2/device/verify`,
  ];
  let consentUrl = `${XAI_ACCOUNTS_ORIGIN}/oauth2/device/consent?user_code=${encodeURIComponent(userCode)}`;
  let verified = false;
  let alreadyApproved = false;

  for (const verifyUrl of verifyUrls) {
    const response = await session.request(verifyUrl, {
      method: "POST",
      form: { user_code: userCode },
      headers: xaiDeviceFormHeaders(verificationUrl),
    });
    const location = responseLocation(response, XAI_ACCOUNTS_ORIGIN);
    const text = responseText(response);
    emitTrace(trace, "设备码验证响应", {
      status: response.status,
      url: redactOAuthURL(verifyUrl),
      location: redactOAuthURL(location),
    });
    if (isRateLimitedResponse(response, location)) {
      throw oauthProtocolError("xAI OAuth 设备码验证触发限流。", "rate_limited", response.status);
    }
    const locationError = oauthLocationError(location);
    if (locationError) continue;
    if (isSignInUrl(location)) {
      throw new Error("xAI OAuth 自动授权失败：验证设备码时 SSO 登录状态失效。");
    }
    if (isDeviceAuthorizationDone(location) || isAuthorizedBody(text)) {
      verified = true;
      alreadyApproved = true;
      break;
    }
    if (isRedirectStatus(response.status) && location) {
      if (isBareAccountUrl(location)) continue;
      consentUrl = location;
      verified = true;
      break;
    }
    if (response.status < 400 && (isConsentPage("", text) || response.status === 200)) {
      verified = true;
      break;
    }
  }

  if (!verified) {
    throw oauthProtocolError("xAI OAuth 设备码验证未进入授权确认页。", "verify_failed");
  }
  if (alreadyApproved) return;

  const principalId = principalIdFromSso(session.cookie("sso"));
  const consentResponse = await session.request(consentUrl, { followRedirects: true });
  const consentText = responseText(consentResponse);
  if (isBrowserBlockedResponse(consentResponse)) {
    throw oauthProtocolError(
      "xAI OAuth 协议访问授权确认页时受到 Cloudflare 限制。",
      "browser_required",
      consentResponse.status,
    );
  }
  if (isDeviceAuthorizationDone(consentResponse.url) || isAuthorizedBody(consentText)) return;
  if (isSignInUrl(consentResponse.url)) {
    throw new Error("xAI OAuth 自动授权失败：打开授权确认页时 SSO 登录状态失效。");
  }

  const hiddenFields = parseHtmlFormFields(consentText);
  const overlay = {
    ...hiddenFields,
    user_code: userCode,
    action: "allow",
    principal_type: "User",
    referrer: XAI_DEVICE_FLOW_REFERRER,
    plan: XAI_DEVICE_FLOW_PLAN,
  };
  if (principalId && !String(overlay.principal_id || "").trim()) {
    overlay.principal_id = principalId;
  }
  const withReferrer = {
    user_code: userCode,
    action: "allow",
    principal_type: "User",
    referrer: XAI_DEVICE_FLOW_REFERRER,
    plan: XAI_DEVICE_FLOW_PLAN,
  };
  if (principalId) withReferrer.principal_id = principalId;
  const variants = [
    ["referrer", withReferrer],
    ["页面字段", overlay],
    ["最小字段", { user_code: userCode, action: "allow" }],
  ];
  const approveUrls = [
    `${XAI_OAUTH_ISSUER}/oauth2/device/approve`,
    `${XAI_ACCOUNTS_ORIGIN}/oauth2/device/approve`,
  ];

  for (const approveUrl of approveUrls) {
    for (const [variant, form] of variants) {
      const response = await session.request(approveUrl, {
        method: "POST",
        form,
        headers: xaiDeviceFormHeaders(consentResponse.url || consentUrl),
      });
      const location = responseLocation(response, XAI_OAUTH_ISSUER);
      const text = responseText(response);
      emitTrace(trace, "设备授权确认响应", {
        variant,
        status: response.status,
        url: redactOAuthURL(approveUrl),
        location: redactOAuthURL(location),
      });
      if (isRateLimitedResponse(response, location)) {
        throw oauthProtocolError("xAI OAuth 授权确认触发限流。", "rate_limited", response.status);
      }
      const locationError = oauthLocationError(location);
      if (locationError) continue;
      if (isSignInUrl(location)) {
        throw new Error("xAI OAuth 自动授权失败：提交授权确认时 SSO 登录状态失效。");
      }
      if (isDeviceAuthorizationDone(location) || isAuthorizedBody(text)) return;
      if (isRedirectStatus(response.status) && location) {
        const followed = await session.request(location, { followRedirects: false });
        const followedLocation = responseLocation(followed, XAI_ACCOUNTS_ORIGIN);
        if (
          isDeviceAuthorizationDone(followed.url) ||
          isDeviceAuthorizationDone(followedLocation) ||
          isAuthorizedBody(responseText(followed))
        ) {
          return;
        }
      }
    }
  }

  throw oauthProtocolError("xAI OAuth 授权确认没有返回完成状态。", "approval_incomplete");
}

export async function approveXaiDeviceCodeInBrowser(cdp, deviceCode, {
  signal,
  trace = () => {},
  wait = waitWithSignal,
  timeoutMs = 90000,
} = {}) {
  if (!cdp?.send || !cdp?.evaluate) {
    throw new Error("xAI OAuth 浏览器授权需要可用的 CDP 页面连接。");
  }
  const userCode = String(deviceCode?.user_code || "").trim();
  const verificationUrl = validateXaiOAuthEndpoint(
    deviceCode?.verification_uri_complete || deviceCode?.verification_uri,
    "verification_uri",
  );
  if (!userCode) throw new Error("xAI OAuth 设备码响应缺少 user_code。");

  emitTrace(trace, "浏览器访问设备验证页", {
    url: redactOAuthURL(verificationUrl),
  });
  const navigation = await cdp.send("Page.navigate", { url: verificationUrl });
  if (navigation?.errorText) {
    throw oauthProtocolError(
      `xAI OAuth 浏览器打开设备验证页失败：${navigation.errorText}`,
      "browser_navigation_failed",
    );
  }

  let state = await waitForXaiBrowserDeviceState(cdp, {
    signal,
    trace,
    wait,
    timeoutMs,
    accept: (value) => value.verifyForm || value.approveForm || value.done,
  });
  if (state.done) return;

  if (state.verifyForm) {
    const submitted = await submitXaiBrowserVerifyForm(cdp, userCode);
    if (!submitted?.submitted) {
      throw oauthProtocolError(
        "xAI OAuth 浏览器设备码表单提交失败。",
        "browser_verify_failed",
      );
    }
    emitTrace(trace, "浏览器提交设备码", {});
    state = await waitForXaiBrowserDeviceState(cdp, {
      signal,
      trace,
      wait,
      timeoutMs,
      accept: (value) => value.approveForm || value.done,
    });
    if (state.done) return;
  }

  const approved = await submitXaiBrowserApproveForm(cdp, userCode);
  if (!approved?.submitted) {
    throw oauthProtocolError(
      "xAI OAuth 浏览器授权确认表单提交失败。",
      "browser_approval_failed",
    );
  }
  emitTrace(trace, "浏览器提交授权确认", {
    form_action: redactOAuthURL(approved.action),
  });
  await waitForXaiBrowserDeviceState(cdp, {
    signal,
    trace,
    wait,
    timeoutMs,
    accept: (value) => value.done,
  });
}

async function waitForXaiBrowserDeviceState(cdp, {
  signal,
  trace,
  wait,
  timeoutMs,
  accept,
}) {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 90000);
  let lastState = null;
  let lastHref = "";
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      lastState = await readXaiBrowserDeviceState(cdp);
    } catch {
      await wait(250, signal);
      continue;
    }
    if (lastState.href !== lastHref) {
      lastHref = lastState.href;
      emitTrace(trace, "浏览器授权页面变化", {
        url: redactOAuthURL(lastState.href),
        title: lastState.title,
        verify_form: lastState.verifyForm,
        approve_form: lastState.approveForm,
        done: lastState.done,
      });
    }
    if (lastState.signIn) {
      throw new Error("xAI OAuth 自动授权失败：浏览器中的 SSO 登录状态已经失效。");
    }
    if (lastState.blocked) {
      throw oauthProtocolError(
        "xAI OAuth 浏览器页面受到 Cloudflare 限制。",
        "browser_blocked",
      );
    }
    if (lastState.browserError) {
      throw oauthProtocolError(
        "xAI OAuth 浏览器页面加载失败，请检查当前代理连接。",
        "browser_navigation_failed",
      );
    }
    if (lastState.invalidAction) {
      throw oauthProtocolError(
        "xAI OAuth 浏览器授权表单提交失败：Invalid action。",
        "browser_approval_failed",
      );
    }
    if (accept(lastState)) return lastState;
    await wait(300, signal);
  }
  throwIfAborted(signal);
  throw oauthProtocolError(
    `xAI OAuth 浏览器自动授权等待超时。页面：${redactOAuthURL(lastState?.href || "")}`,
    "browser_timeout",
  );
}

function readXaiBrowserDeviceState(cdp) {
  return cdp.evaluate(`
    (() => {
      const href = location.href;
      const text = document.body?.innerText || "";
      const formPaths = [...document.forms].map((form) => {
        try {
          return new URL(form.getAttribute("action") || href, href).pathname.toLowerCase();
        } catch {
          return "";
        }
      });
      return {
        href,
        title: document.title || "",
        verifyForm: formPaths.includes("/oauth2/device/verify"),
        approveForm: formPaths.includes("/oauth2/device/approve"),
        done: /\\/oauth2\\/device\\/done|\\/device\\/done|device_authorized/i.test(href) ||
          /设备已授权|device (?:is )?authorized|authorization complete|you have authorized/i.test(text),
        signIn: /sign-in|sign-up/i.test(href),
        blocked: /sorry, you have been blocked|attention required|cloudflare ray id/i.test(text),
        browserError: href.startsWith("chrome-error://"),
        invalidAction: /invalid action/i.test(text),
      };
    })()
  `);
}

function submitXaiBrowserVerifyForm(cdp, userCode) {
  return cdp.evaluate(`
    (() => {
      const form = [...document.forms].find((item) => {
        try {
          return new URL(item.getAttribute("action") || location.href, location.href).pathname ===
            "/oauth2/device/verify";
        } catch {
          return false;
        }
      });
      if (!form) return { submitted: false, action: "" };
      const input = form.elements.namedItem("user_code");
      if (input) input.value = ${JSON.stringify(userCode)};
      const submitter = form.querySelector('button[type="submit"], input[type="submit"]');
      if (typeof form.requestSubmit === "function") form.requestSubmit(submitter || undefined);
      else HTMLFormElement.prototype.submit.call(form);
      return { submitted: true, action: form.getAttribute("action") || "" };
    })()
  `);
}

function submitXaiBrowserApproveForm(cdp, userCode) {
  return cdp.evaluate(`
    (() => {
      const form = [...document.forms].find((item) => {
        try {
          return new URL(item.getAttribute("action") || location.href, location.href).pathname ===
            "/oauth2/device/approve";
        } catch {
          return false;
        }
      });
      if (!form) return { submitted: false, action: "" };
      const values = {
        user_code: ${JSON.stringify(userCode)},
        action: "allow",
        principal_type: "User",
      };
      for (const [name, value] of Object.entries(values)) {
        let input = form.elements.namedItem(name);
        if (!input) {
          input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          form.append(input);
        }
        input.value = value;
      }
      const action = form.getAttribute("action") || "";
      HTMLFormElement.prototype.submit.call(form);
      return { submitted: true, action };
    })()
  `);
}

async function enrichXaiTokenIdentity(token, {
  proxyUrl,
  signal,
  request,
}) {
  const idIdentity = parseJwtIdentity(token?.id_token);
  const accessIdentity = parseJwtIdentity(token?.access_token);
  const result = {
    ...token,
    email: token?.email || idIdentity.email || accessIdentity.email,
    sub: token?.sub || idIdentity.sub || accessIdentity.sub,
  };
  if (result.email || !result.access_token) return result;
  try {
    const response = await request(`${XAI_OAUTH_ISSUER}/oauth2/userinfo`, {
      headers: {
        Authorization: `Bearer ${result.access_token}`,
        Accept: "application/json",
      },
      proxyUrl,
      signal,
    });
    if (response.status < 400 && response.body && typeof response.body === "object") {
      result.email = String(response.body.email || "").trim();
      result.sub = result.sub || String(response.body.sub || "").trim();
    }
  } catch {}
  return result;
}

function createCookieSession({ initialCookies, proxyUrl, signal, request }) {
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
          redirect: "manual",
        });
        absorbSetCookies(scopedCookies, response.headers, currentUrl);
        response.url = response.url || currentUrl;
        if (!followRedirects || !isRedirectStatus(response.status)) return response;
        const nextUrl = responseLocation(response, currentUrl);
        if (!nextUrl) return response;
        currentUrl = validateXaiOAuthEndpoint(nextUrl, "redirect_uri");
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) {
          method = "GET";
          form = undefined;
        }
      }
      throw new Error("xAI OAuth 页面重定向次数过多。");
    },
  };
}

function selectCookie(cookies, name) {
  const matches = cookies.filter((cookie) => cookie?.name === name && String(cookie.value || "").trim());
  return matches.find((cookie) => /(?:^|\.)x\.ai$/i.test(String(cookie.domain || "").replace(/^\./, ""))) || matches[0];
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

function parseHtmlFormFields(html) {
  const fields = {};
  for (const match of String(html || "").matchAll(/<input\b[^>]*>/gi)) {
    const tag = match[0];
    const name = htmlAttribute(tag, "name");
    if (!name || /^submit$/i.test(name)) continue;
    fields[name] = htmlAttribute(tag, "value");
  }
  return fields;
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

function principalIdFromSso(sso) {
  const claims = parseJwtClaims(sso);
  for (const key of ["sub", "principal_id", "principalId", "user_id", "userId", "uid"]) {
    if (claims[key] !== undefined && String(claims[key]).trim()) return String(claims[key]).trim();
  }
  for (const parent of ["user", "account", "identity", "profile"]) {
    const nested = claims[parent];
    if (!nested || typeof nested !== "object") continue;
    for (const key of ["sub", "principal_id", "user_id", "userId", "uid"]) {
      if (nested[key] !== undefined && String(nested[key]).trim()) return String(nested[key]).trim();
    }
  }
  return "";
}

function parseJwtClaims(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function xaiDeviceFormHeaders(referer) {
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

function responseText(response) {
  if (typeof response?.body === "string") return response.body;
  if (typeof response?.rawBody === "string") return response.rawBody;
  return "";
}

function responseLocation(response, baseUrl) {
  const location = headerValue(response?.headers, "location");
  if (!location) return "";
  try {
    return new URL(location, baseUrl).href;
  } catch {
    return "";
  }
}

function headerValue(headers, name) {
  return headerValues(headers, name)[0] || "";
}

function headerValues(headers, name) {
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

function mergeHeaders(primary, secondary) {
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

function isRedirectStatus(status) {
  return [301, 302, 303, 307, 308].includes(Number(status));
}

function isSignInUrl(url) {
  const value = String(url || "").toLowerCase();
  return /sign-in|sign-up/.test(value);
}

function isBareAccountUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "").toLowerCase();
    return (path === "/account" || path === "/accounts") && !/device|consent|oauth2/.test(url);
  } catch {
    return false;
  }
}

function oauthLocationError(url) {
  try {
    return new URL(url).searchParams.get("error") || "";
  } catch {
    return "";
  }
}

function isDeviceAuthorizationDone(url) {
  const value = String(url || "").toLowerCase();
  return /\/oauth2\/device\/done|\/device\/done|device_authorized/.test(value) && !oauthLocationError(value);
}

function isAuthorizedBody(body) {
  return /设备已授权|device (?:is )?authorized|you have authorized|authorization complete/i.test(String(body || ""));
}

function isConsentPage(url, body = "") {
  return /consent|device\/verify|device\/approve|authorize grok|wants to access|请求访问/i.test(`${url}\n${body}`);
}

function isRateLimitedResponse(response, url = "") {
  const body = typeof response?.body === "string"
    ? response.body
    : JSON.stringify(response?.body || {});
  return /slow_down|rate_limited|rate limit|too many|\b429\b/i.test(
    `${response?.status || ""} ${url} ${body}`,
  );
}

function isBrowserBlockedResponse(response) {
  const body = responseText(response);
  return Number(response?.status) === 403 &&
    /sorry, you have been blocked|attention required|cloudflare ray id/i.test(body);
}

function requiresBrowserApproval(error) {
  return [
    "browser_required",
    "browser_blocked",
    "browser_navigation_failed",
  ].includes(String(error?.oauthError || ""));
}

function oauthProtocolError(message, oauthError = "", status = 0) {
  const error = new Error(message);
  error.oauthError = String(oauthError || "");
  error.oauthStatus = Number(status || 0);
  return error;
}

function isRetryableDeviceFlowError(error) {
  if ([
    "invalid_grant",
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
  return /超时|timeout|network|socket|ECONN|重置|连接|temporary/i.test(String(error?.message || error));
}

function deviceFlowBackoffMs(attempt) {
  return Math.max(1000, Math.min(20000, Number(attempt || 1) * 2000));
}

function fastPollIntervalMs(intervalSeconds) {
  const hinted = Number(intervalSeconds || 1) * 1000;
  return Math.max(400, Math.min(1500, Number.isFinite(hinted) ? hinted : 1000));
}

async function waitForDeviceFlowSlot(wait, signal) {
  let release;
  const previous = deviceFlowQueue;
  deviceFlowQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const remaining = lastDeviceFlowRequestAt + XAI_DEVICE_FLOW_RETRY_GAP_MS - Date.now();
    if (remaining > 0) await wait(remaining, signal);
    lastDeviceFlowRequestAt = Date.now();
  } finally {
    release();
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
