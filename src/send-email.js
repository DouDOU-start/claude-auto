import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { startProxyBridge, parseProxyUrl } from "./proxy-bridge.js";
import { CdpClient, findClaudePage } from "./cdp-client.js";
import { resolveBrowserPath } from "./browser-utils.js";
import { maskProxy, resolveProxyUrl } from "./config.js";
import {
  launchChrome,
  randomPortHint,
  stopChrome,
  timestamp,
  wait,
  waitForDevTools,
  writeBrowserProfile,
} from "./core/browser-runtime.js";

const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const proxyUrl = resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });
  const upstream = parseProxyUrl(proxyUrl);
  const chromePath = resolveBrowserPath({
    requestedPath: args.chrome,
    projectRoot,
    fallbackPath: DEFAULT_CHROME,
  });
  const email = args.email || `test-${randomBytes(5).toString("hex")}@${args.domain || "k9ray.com"}`;
  const debugPort = Number(args.debugPort || 0) || randomPortHint();
  const profileDir = resolve(
    args.profileDir ||
      join(projectRoot, "profiles", `claude-${timestamp()}-${randomBytes(4).toString("hex")}`),
  );
  const logDir = resolve(args.logDir || join(projectRoot, "logs"));
  const keepOpen = args.keepOpen !== false;

  await mkdir(profileDir, { recursive: true });
  await mkdir(join(profileDir, "Default"), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeBrowserProfile(profileDir);

  const bridge = await startProxyBridge({
    listenHost: "127.0.0.1",
    listenPort: Number(args.bridgePort || 0),
    upstream,
  });

  const chrome = launchChrome({
    chromePath,
    profileDir,
    proxyServer: `http://${bridge.host}:${bridge.port}`,
    debugPort,
    url: "https://claude.ai/login",
  });

  try {
    await waitForDevTools(debugPort, 30000);
    await wait(4000);

    const page = await findClaudePage(debugPort);
    const cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    try {
      const pageState = await cdp.evaluate(`({
        href: location.href,
        title: document.title,
        lang: document.documentElement.lang,
        country: document.head?.dataset?.ionIpCountry || ""
      })`);
      const readyState = await waitForLoginReady(cdp, 60000);
      const inputState = await syncVisibleEmailInput(cdp, email);
      const fetchResult = await sendMagicLink(cdp, email);
      await wait(1000);
      const result = {
        email,
        pageState,
        readyState,
        inputState,
        fetchResult,
        profileDir,
        debugPort,
        bridge: {
          localProxy: `http://${bridge.host}:${bridge.port}`,
          upstreamProxy: maskProxy(proxyUrl),
        },
        requests: cdp.interestingAuthRequests(),
      };
      const outputPath = join(logDir, `send-result-${timestamp()}.json`);
      await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
      console.log(JSON.stringify({
        email,
        status: fetchResult.status,
        sent: parseSent(fetchResult.responseText),
        responseText: fetchResult.responseText,
        profileDir,
        debugPort,
        localProxy: `http://${bridge.host}:${bridge.port}`,
        outputPath,
      }, null, 2));
    } finally {
      cdp.close();
    }
  } finally {
    if (!keepOpen) {
      await stopChrome(chrome);
      await bridge.close();
    } else {
      console.log("Chrome 和代理桥将继续运行，完成后请手动关闭 Chrome。");
    }
  }
}

async function sendMagicLink(cdp, email) {
  return cdp.evaluate(`
    (async () => {
      const body = {
        utc_offset: new Date().getTimezoneOffset() * -1,
        email_address: ${JSON.stringify(email)},
        login_intent: null,
        locale: document.documentElement.lang || navigator.language || "en-US",
        return_to: null,
        source: "claude"
      };
      const response = await fetch("/api/auth/send_magic_link", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "anthropic-client-platform": "web_claude_ai",
          "anthropic-client-version": document.documentElement.dataset.version || "1.0.0",
          "anthropic-client-sha":
            document.documentElement.dataset.gitHash ||
            document.documentElement.dataset.buildId ||
            "",
          "anthropic-device-id":
            document.cookie.match(/(?:^|; )anthropic-device-id=([^;]+)/)?.[1] || "",
          "anthropic-anonymous-id":
            document.cookie.match(/(?:^|; )ajs_anonymous_id=([^;]+)/)?.[1] || ""
        },
        body: JSON.stringify(body)
      });
      return {
        requestBody: body,
        status: response.status,
        statusText: response.statusText,
        responseText: await response.text(),
        responseHeaders: Object.fromEntries(response.headers.entries())
      };
    })()
  `);
}

async function waitForLoginReady(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    try {
      lastState = await cdp.evaluate(`({
        href: location.href,
        title: document.title,
        hasEmailInput: Boolean(document.querySelector('input#email, input[type="email"], input[data-testid="email"]')),
        bodyText: document.body?.innerText?.slice(0, 300) || ""
      })`);
      if (
        lastState?.href?.includes("claude.ai/login") &&
        lastState?.title === "Sign in - Claude" &&
        lastState?.hasEmailInput
      ) {
        return lastState;
      }
    } catch {
      // Cloudflare 或 Claude 加载期间可能替换页面执行上下文。
    }
    await wait(500);
  }
  throw new Error(`Claude 登录页未能在超时前就绪。最终状态：${JSON.stringify(lastState)}`);
}

async function syncVisibleEmailInput(cdp, email) {
  return cdp.evaluate(`
    (() => {
      const input = document.querySelector('input#email, input[type="email"], input[data-testid="email"]');
      if (!input) return { ok: false, reason: "未找到邮箱输入框" };
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, ${JSON.stringify(email)});
      else input.value = ${JSON.stringify(email)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        value: input.value,
        title: document.title,
        href: location.href
      };
    })()
  `);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--no-keep-open") args.keepOpen = false;
    else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = value;
        i += 1;
      }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
用法：
  node src/send-email.js [选项]

选项：
  --email <邮箱>         接收 Magic Link 的邮箱，默认随机生成。
  --domain <域名>        随机邮箱域名，默认 k9ray.com。
  --proxy <代理地址>     上游认证代理，优先于 config/proxy.json。
  --chrome <路径>        Chrome 或 Chromium 可执行文件。
  --bridge-port <端口>   本地代理桥端口，默认随机。
  --debug-port <端口>    Chrome DevTools 端口，默认随机。
  --profile-dir <路径>   Chrome 用户目录。
  --log-dir <路径>       结果目录，默认 ./logs。
  --no-keep-open         发送完成后关闭 Chrome 和代理桥。
  --help                 显示帮助。

示例：
  node src/send-email.js --email test-demo@k9ray.com
`);
}

function parseSent(responseText) {
  try {
    return Boolean(JSON.parse(responseText).sent);
  } catch {
    return false;
  }
}
