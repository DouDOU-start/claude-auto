import { resolve } from "node:path";
import { parseArgs } from "./core/cli.js";
import { openBrowserRuntime, wait, waitForBrowserStop } from "./core/browser-runtime.js";
import { resolveProxyUrl } from "./config.js";

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.sessionKey) {
    printHelp();
    return;
  }
  const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const proxyUrl = resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });
  console.log("[1/4] 正在启动代理桥和 Chrome……");
  const runtime = await openBrowserRuntime({
    projectRoot,
    proxyUrl,
    chromePath: args.chrome,
    profileDir: args.profileDir,
    debugPort: args.debugPort,
    bridgePort: args.bridgePort,
    startUrl: "https://claude.ai/",
    profilePrefix: "session",
    keepProfile: true,
  });

  try {
    console.log("[2/4] 正在写入会话 Cookie……");
    await setClaudeCookie(runtime.cdp, "sessionKey", args.sessionKey, true);
    if (args.sessionKeyLc) {
      await setClaudeCookie(runtime.cdp, "sessionKeyLC", args.sessionKeyLc, false);
    }
    if (args.routingHint) {
      await setClaudeCookie(runtime.cdp, "routingHint", args.routingHint, true);
    }

    console.log("[3/4] 正在打开目标页面……");
    await runtime.cdp.send("Page.navigate", { url: args.url || "https://claude.ai/chat" });
    await wait(Number(args.waitMs || 10000));
    const state = await runtime.cdp.evaluate(`({
      href: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 3000) || ""
    })`);
    console.log("[4/4] 会话页面已打开。");
    console.log(JSON.stringify({
      profileDir: runtime.profileDir,
      debugPort: runtime.debugPort,
      localProxy: runtime.bridge ? `http://${runtime.bridge.host}:${runtime.bridge.port}` : "",
      state,
    }, null, 2));

    if (!args.noKeepOpen) {
      console.log("手动关闭 Chrome，或按 Ctrl+C 结束浏览器和代理桥。");
      await waitForBrowserStop(runtime.chrome);
    }
  } finally {
    await runtime.close();
  }
}

async function setClaudeCookie(cdp, name, value, httpOnly) {
  const result = await cdp.send("Network.setCookie", {
    name,
    value,
    domain: ".claude.ai",
    path: "/",
    secure: true,
    httpOnly,
    sameSite: "Lax",
    expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 28,
    url: "https://claude.ai/",
  });
  if (!result.success) throw new Error(`无法写入 Cookie：${name}`);
}

function printHelp() {
  console.log(`
用法：
  node src/open-with-session.js --session-key <值> [选项]

选项：
  --session-key <值>       必填，sessionKey Cookie。
  --session-key-lc <值>    可选，sessionKeyLC Cookie。
  --routing-hint <值>      可选，routingHint Cookie。
  --url <地址>             注入 Cookie 后打开的地址。
  --proxy <代理地址>       上游认证代理。
  --chrome <路径>          Chrome 或 Chromium 可执行文件。
  --profile-dir <路径>     Chrome 用户目录。
  --bridge-port <端口>     本地代理桥端口。
  --debug-port <端口>      DevTools 端口。
  --wait-ms <毫秒>         导航后的等待时间，默认 10000。
  --no-keep-open           页面打开后立即关闭资源。
  --help                   显示帮助。
`);
}
