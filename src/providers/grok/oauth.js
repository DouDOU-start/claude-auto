import { throwIfAborted, waitWithSignal } from "../../core/abort.js";
import { approveXaiDeviceCodeInBrowser } from "./oauth/browser.js";
import { XAI_DEVICE_FLOW_RETRIES, XAI_OAUTH_DISCOVERY_URL } from "./oauth/constants.js";
import { oauthHttpRequest } from "./oauth/http.js";
import {
  approveXaiDeviceCode,
  createXaiSsoSession,
  discoverXaiOAuth,
  enrichXaiTokenIdentity,
  pollXaiOAuthToken,
  requestXaiDeviceCode,
  validateXaiSsoSession,
} from "./oauth/protocol.js";
import { emitOAuthTrace, redactOAuthURL } from "./oauth/redaction.js";
import {
  deviceFlowBackoffMs,
  fastPollIntervalMs,
  isRetryableDeviceFlowError,
  normalizeDeviceFlowRetries,
  requiresBrowserApproval,
} from "./oauth/utils.js";

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
  emitOAuthTrace(trace, "服务发现开始", { url: XAI_OAUTH_DISCOVERY_URL });
  const discovery = await discoverXaiOAuth({ proxyUrl, signal, request });
  emitOAuthTrace(trace, "服务发现完成", discovery);

  const totalRetries = normalizeDeviceFlowRetries(retries);
  let preferBrowserApproval = !ssoPreflight.confirmed;
  let lastError = null;
  for (let attempt = 1; attempt <= totalRetries; attempt += 1) {
    throwIfAborted(signal);
    if (attempt > 1) {
      updateProgress(`xAI OAuth 授权正在重试 ${attempt}/${totalRetries}……`);
      await wait(deviceFlowBackoffMs(attempt - 1), signal);
    }

    let approvalMethod = preferBrowserApproval ? "browser" : "protocol";
    try {
      const deviceCode = await requestXaiDeviceCode({
        discovery,
        proxyUrl,
        signal,
        request,
        wait,
      });
      emitOAuthTrace(trace, "设备码申请完成", {
        attempt,
        verification_uri: redactOAuthURL(deviceCode.verification_uri),
        verification_uri_complete: redactOAuthURL(deviceCode.verification_uri_complete),
        interval: Number(deviceCode.interval || 0),
        expires_in: Number(deviceCode.expires_in || 0),
      });

      updateProgress("正在使用 xAI 登录状态自动确认设备授权……");
      if (approvalMethod === "browser") {
        await browserApprove(cdp, deviceCode, { signal, trace, wait });
      } else {
        try {
          await approveXaiDeviceCode(session, deviceCode, { signal, trace });
        } catch (error) {
          if (!requiresBrowserApproval(error)) throw error;
          approvalMethod = "browser";
          preferBrowserApproval = true;
          updateProgress("协议页面请求受到限制，正在改用当前浏览器自动确认授权……");
          emitOAuthTrace(trace, "切换浏览器授权", {
            attempt,
            reason: String(error?.message || error),
          });
          await browserApprove(cdp, deviceCode, { signal, trace, wait });
        }
      }
      emitOAuthTrace(trace, "自动授权完成，开始令牌轮询", {
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
      return { ...enriched, token_endpoint: discovery.token_endpoint };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableDeviceFlowError(error, { approvalMethod });
      if (error?.oauthError === "invalid_grant" && approvalMethod === "protocol") {
        preferBrowserApproval = true;
      }
      emitOAuthTrace(trace, "设备授权尝试失败", {
        attempt,
        method: approvalMethod,
        message: String(error?.message || error),
        retryable,
      });
      if (attempt >= totalRetries || !retryable) throw error;
    }
  }

  throw lastError || new Error("xAI OAuth 自动授权失败。");
}

export {
  XAI_DEVICE_GRANT_TYPE,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_SCOPE,
} from "./oauth/constants.js";
export { approveXaiDeviceCodeInBrowser } from "./oauth/browser.js";
export { oauthHttpRequest } from "./oauth/http.js";
export {
  discoverXaiOAuth,
  pollXaiOAuthToken,
  readXaiSsoCookie,
  requestXaiDeviceCode,
} from "./oauth/protocol.js";
export { parseJwtIdentity, validateXaiOAuthEndpoint } from "./oauth/utils.js";
