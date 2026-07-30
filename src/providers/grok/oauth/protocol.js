import { throwIfAborted, waitWithSignal } from "../../../core/abort.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  MAX_POLL_DURATION_MS,
  XAI_ACCOUNTS_ORIGIN,
  XAI_DEVICE_FLOW_PLAN,
  XAI_DEVICE_FLOW_REFERRER,
  XAI_DEVICE_FLOW_RETRIES,
  XAI_DEVICE_FLOW_RETRY_GAP_MS,
  XAI_DEVICE_GRANT_TYPE,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_ISSUER,
  XAI_OAUTH_SCOPE,
} from "./constants.js";
import { createCookieSession, oauthHttpRequest, selectCookie } from "./http.js";
import { emitOAuthTrace, redactOAuthURL } from "./redaction.js";
import {
  deviceFlowBackoffMs,
  isAuthorizedBody,
  isBareAccountUrl,
  isBrowserBlockedResponse,
  isConsentPage,
  isDeviceAuthorizationDone,
  isRateLimitedResponse,
  isRedirectStatus,
  isSignInUrl,
  normalizeDeviceFlowRetries,
  oauthLocationError,
  oauthProtocolError,
  parseHtmlFormFields,
  parseJwtIdentity,
  principalIdFromSso,
  responseLocation,
  responseText,
  validateXaiOAuthEndpoint,
  xaiDeviceFormHeaders,
} from "./utils.js";

let deviceFlowQueue = Promise.resolve();
let lastDeviceFlowRequestAt = 0;

export async function discoverXaiOAuth({
  proxyUrl = "",
  signal,
  request = oauthHttpRequest,
} = {}) {
  const response = await request(XAI_OAUTH_DISCOVERY_URL, { proxyUrl, signal });
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
  const totalRetries = normalizeDeviceFlowRetries(retries);
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
      return { ...value, token_endpoint: discovery.token_endpoint };
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
    emitOAuthTrace(trace, "令牌轮询请求", { attempt, interval_ms: intervalMs });

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
      emitOAuthTrace(trace, "令牌轮询网络错误", {
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
    emitOAuthTrace(trace, "令牌轮询响应", {
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
          if (value.error === "invalid_grant" && /access denied/i.test(description)) {
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

export async function createXaiSsoSession(cdp, {
  proxyUrl = "",
  signal,
  request = oauthHttpRequest,
  trace = () => {},
} = {}) {
  const sso = await readXaiSsoCookie(cdp);
  emitOAuthTrace(trace, "读取 SSO Cookie 完成", {
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

export async function validateXaiSsoSession(session, { signal, trace = () => {} } = {}) {
  try {
    throwIfAborted(signal);
    const response = await session.request(`${XAI_ACCOUNTS_ORIGIN}/`, {
      followRedirects: true,
    });
    const confirmed = response.status < 400 && !isSignInUrl(response.url);
    emitOAuthTrace(trace, "SSO 登录态预校验", {
      status: response.status,
      url: redactOAuthURL(response.url),
      confirmed,
    });
    return { confirmed, status: response.status, url: response.url };
  } catch (error) {
    throwIfAborted(signal);
    emitOAuthTrace(trace, "SSO 登录态预校验异常", {
      message: String(error?.message || error),
    });
    return { confirmed: false, status: 0, url: "" };
  }
}

export async function approveXaiDeviceCode(session, deviceCode, { signal, trace = () => {} } = {}) {
  const userCode = String(deviceCode?.user_code || "").trim();
  const verificationUrl = validateXaiOAuthEndpoint(
    deviceCode?.verification_uri_complete || deviceCode?.verification_uri,
    "verification_uri",
  );
  if (!userCode) throw new Error("xAI OAuth 设备码响应缺少 user_code。");

  emitOAuthTrace(trace, "协议访问设备验证页", {
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
    emitOAuthTrace(trace, "设备码验证响应", {
      status: response.status,
      url: redactOAuthURL(verifyUrl),
      location: redactOAuthURL(location),
    });
    if (isRateLimitedResponse(response, location)) {
      throw oauthProtocolError("xAI OAuth 设备码验证触发限流。", "rate_limited", response.status);
    }
    if (oauthLocationError(location)) continue;
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
      emitOAuthTrace(trace, "设备授权确认响应", {
        variant,
        status: response.status,
        url: redactOAuthURL(approveUrl),
        location: redactOAuthURL(location),
      });
      if (isRateLimitedResponse(response, location)) {
        throw oauthProtocolError("xAI OAuth 授权确认触发限流。", "rate_limited", response.status);
      }
      if (oauthLocationError(location)) continue;
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

export async function enrichXaiTokenIdentity(token, {
  proxyUrl = "",
  signal,
  request = oauthHttpRequest,
} = {}) {
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
