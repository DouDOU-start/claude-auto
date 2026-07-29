import { resolve } from "node:path";
import { parseArgs } from "./core/cli.js";
import { openBrowserRuntime, waitForBrowserStop } from "./core/browser-runtime.js";
import { maskProxy, resolveProxyUrl } from "./config.js";

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
  const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const proxyUrl = resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });

  console.log("[1/2] 正在启动本地代理桥……");
  const runtime = await openBrowserRuntime({
    projectRoot,
    proxyUrl,
    chromePath: args.chrome,
    profileDir: args.profileDir,
    debugPort: args.debugPort,
    bridgePort: args.bridgePort,
    startUrl: args.url || "https://claude.ai/",
    profilePrefix: "browser",
    keepProfile: true,
  });
  console.log("[2/2] Chrome 已启动。");
  console.log(JSON.stringify({
    profileDir: runtime.profileDir,
    debugPort: runtime.debugPort,
    localProxy: runtime.bridge ? `http://${runtime.bridge.host}:${runtime.bridge.port}` : "",
    upstreamProxy: maskProxy(proxyUrl),
  }, null, 2));
  console.log("手动关闭 Chrome，或按 Ctrl+C 结束浏览器和代理桥。");

  await waitForBrowserStop(runtime.chrome);
  await runtime.close();
}

function printHelp() {
  console.log(`
用法：
  node src/open-browser.js [选项]

只打开一个使用代理的 Chrome 窗口，不执行登录或注册自动化。

选项：
  --url <地址>          打开的地址，默认 https://claude.ai/。
  --proxy <代理地址>    上游认证代理，优先于 config/app.local.json。
  --chrome <路径>       Chrome 或 Chromium 可执行文件。
  --profile-dir <路径>  Chrome 用户目录。
  --bridge-port <端口>  本地代理桥端口，默认随机。
  --debug-port <端口>   DevTools 端口，默认随机。
  --help                显示帮助。
`);
}
