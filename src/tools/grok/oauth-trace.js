import { mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "../../core/cli.js";
import { openBrowserRuntime } from "../../core/browser-runtime.js";
import { maskProxy, resolveCliProxyXaiOAuth, resolveProxyUrl } from "../../config.js";
import {
  authorizeXaiDevice,
  oauthHttpRequest,
  XAI_DEVICE_GRANT_TYPE,
} from "../../providers/grok/oauth.js";
import {
  isXaiRelatedURL as isInterestingURL,
  oauthFingerprints,
  redactOAuthURL as sanitizeURL,
  sanitizeOAuthFormText as sanitizeFormText,
  sanitizeOAuthHeaders as sanitizeHeaders,
  sanitizeOAuthText as sanitizeText,
  sanitizeOAuthValue as sanitizeValue,
} from "../../providers/grok/oauth/redaction.js";

const projectRoot = resolve(
  new URL("../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
);

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.profileDir) throw new Error("请通过 --profile-dir 指定已登录的 Grok 浏览器目录。");

  const profileDir = resolve(args.profileDir);
  const upstreamProxy = resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });
  const oauthConfig = resolveCliProxyXaiOAuth({ projectRoot });
  const initialPollDelayMs = Math.max(0, Number(args.initialPollDelay || 6000));
  const trace = {
    startedAt: new Date().toISOString(),
    profileDir,
    profileName: basename(profileDir),
    browserProxy: maskProxy(upstreamProxy),
    oauthProxy: oauthConfig.useProxy ? "浏览器本地代理桥" : "直连",
    initialPollDelayMs,
    events: [],
  };

  const runtime = await openBrowserRuntime({
    projectRoot,
    proxyUrl: upstreamProxy,
    chromePath: args.chrome,
    profileDir,
    debugPort: args.debugPort,
    bridgePort: args.bridgePort,
    startUrl: "https://accounts.x.ai/account",
    pageUrlIncludes: "accounts.x.ai",
    profilePrefix: "grok-oauth-trace",
    keepProfile: true,
  });
  const oauthProxy = oauthConfig.useProxy && runtime.bridge
    ? `http://${runtime.bridge.host}:${runtime.bridge.port}`
    : "";

  const removeListeners = installBrowserTrace(runtime.cdp, trace);
  let tokenPollCount = 0;
  const tracedRequest = async (url, options = {}) => {
    const isTokenPoll = options.form?.grant_type === XAI_DEVICE_GRANT_TYPE;
    tokenPollCount += isTokenPoll ? 1 : 0;
    if (isTokenPoll && tokenPollCount === 1 && initialPollDelayMs > 0) {
      pushEvent(trace, "oauth", "首次令牌轮询等待", { delayMs: initialPollDelayMs });
      await wait(initialPollDelayMs);
    }
    pushEvent(trace, "oauth", "请求", {
      method: options.method || "GET",
      url: sanitizeURL(url),
      form: sanitizeValue(options.form || null),
      fingerprints: oauthFingerprints(options.form),
      tokenPollCount: isTokenPoll ? tokenPollCount : undefined,
    });
    try {
      const response = await oauthHttpRequest(url, options);
      pushEvent(trace, "oauth", "响应", {
        url: sanitizeURL(url),
        status: response.status,
        headers: sanitizeHeaders(response.headers),
        body: sanitizeValue(response.body),
        fingerprints: oauthFingerprints(response.body),
        tokenPollCount: isTokenPoll ? tokenPollCount : undefined,
      });
      return response;
    } catch (error) {
      pushEvent(trace, "oauth", "网络错误", {
        url: sanitizeURL(url),
        message: sanitizeText(error.message),
        tokenPollCount: isTokenPoll ? tokenPollCount : undefined,
      });
      throw error;
    }
  };

  try {
    const token = await authorizeXaiDevice(runtime.cdp, {
      proxyUrl: oauthProxy,
      request: tracedRequest,
      trace: ({ action, at: _at, ...detail }) => {
        pushEvent(trace, "oauth-flow", action, detail);
      },
      updateProgress(message) {
        console.log(message);
        pushEvent(trace, "流程", "进度", { message });
      },
    });
    trace.outcome = {
      ok: true,
      tokenType: token.token_type || "Bearer",
      expiresIn: Number(token.expires_in || 0),
      hasAccessToken: Boolean(token.access_token),
      hasRefreshToken: Boolean(token.refresh_token),
      hasIDToken: Boolean(token.id_token),
      email: token.email || "",
    };
  } catch (error) {
    trace.outcome = {
      ok: false,
      error: sanitizeText(error.message),
    };
  } finally {
    await wait(1500);
    removeListeners();
    trace.finishedAt = new Date().toISOString();
    const outputPath = await writeTrace(trace);
    await runtime.close();
    console.log(JSON.stringify({ outputPath, outcome: trace.outcome }, null, 2));
    if (!trace.outcome?.ok) process.exitCode = 1;
  }
}

function installBrowserTrace(cdp, trace) {
  const removers = [
    cdp.on("Page.frameNavigated", ({ frame }) => {
      if (!frame?.url || !isInterestingURL(frame.url)) return;
      pushEvent(trace, "浏览器", "页面跳转", {
        url: sanitizeURL(frame.url),
        name: frame.name || "",
      });
    }),
    cdp.on("Network.requestWillBeSent", ({ request, type, initiator, redirectResponse }) => {
      if (!request?.url || !isInterestingURL(request.url)) return;
      if (redirectResponse) {
        pushEvent(trace, "浏览器", "重定向响应", {
          url: sanitizeURL(redirectResponse.url),
          status: redirectResponse.status,
          headers: sanitizeHeaders(redirectResponse.headers),
        });
      }
      pushEvent(trace, "浏览器", "请求", {
        type,
        method: request.method,
        url: sanitizeURL(request.url),
        headers: sanitizeHeaders(request.headers),
        postData: sanitizeFormText(request.postData || ""),
        fingerprints: oauthFingerprints([request.url, request.postData]),
        initiator: initiator?.type || "",
      });
    }),
    cdp.on("Network.responseReceived", ({ response, type }) => {
      if (!response?.url || !isInterestingURL(response.url)) return;
      pushEvent(trace, "浏览器", "响应", {
        type,
        url: sanitizeURL(response.url),
        status: response.status,
        statusText: response.statusText,
        mimeType: response.mimeType,
        headers: sanitizeHeaders(response.headers),
      });
    }),
    cdp.on("Network.loadingFailed", ({ errorText, canceled, type }) => {
      pushEvent(trace, "浏览器", "加载失败", {
        type,
        errorText: sanitizeText(errorText || ""),
        canceled: Boolean(canceled),
      });
    }),
  ];
  return () => removers.forEach((remove) => remove());
}

function pushEvent(trace, source, action, detail = {}) {
  trace.events.push({
    at: new Date().toISOString(),
    offsetMs: Date.now() - Date.parse(trace.startedAt),
    source,
    action,
    ...detail,
  });
}

async function writeTrace(trace) {
  const directory = join(projectRoot, "logs");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const outputPath = join(directory, `grok-oauth-trace-${trace.profileName}-${stamp}.json`);
  await writeFile(outputPath, `${JSON.stringify(trace, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return outputPath;
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function printHelp() {
  console.log(`
用法：
  node src/tools/grok/oauth-trace.js --profile-dir <浏览器目录> [选项]

使用已有 Grok 登录 profile 重新执行 xAI Device OAuth，并生成脱敏抓包时间线。

选项：
  --profile-dir <路径>          必填，已登录的 Chromium 用户目录。
  --proxy <代理地址>            浏览器使用的上游代理，默认读取统一配置。
  --initial-poll-delay <毫秒>   首次 Token 轮询等待时间，默认 6000。
  --chrome <路径>               Chrome 或 Chromium 可执行文件。
  --debug-port <端口>           DevTools 端口，默认随机。
  --bridge-port <端口>          本地代理桥端口，默认随机。
  --help                        显示帮助。
`);
}
