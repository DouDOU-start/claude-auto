import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, isCliEntry } from "../core/cli.js";
import {
  openBrowserRuntime,
  projectRootFrom,
  timestamp,
  waitForBrowserStop,
} from "../core/browser-runtime.js";
import {
  maskProxy,
  resolveProxyUrl,
  resolveRandomEmailDomain,
  resolveRegistrationProviderId,
} from "../config.js";
import { getRegistrationProvider } from "../providers/index.js";

export async function runSendVerificationCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const projectRoot = projectRootFrom(import.meta.url);
  const provider = getRegistrationProvider(
    resolveRegistrationProviderId({ requestedProvider: args.provider, projectRoot }),
  );
  const proxyUrl = args.noProxy ? "" : resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });
  const email =
    args.email ||
    `test-${randomBytes(5).toString("hex")}@${resolveRandomEmailDomain({
      requestedDomain: args.domain,
      projectRoot,
    })}`;
  const logDir = resolve(args.logDir || join(projectRoot, "logs"));
  const keepOpen = !args.noKeepOpen;
  let runtime = null;

  await mkdir(logDir, { recursive: true });
  try {
    runtime = await openBrowserRuntime({
      projectRoot,
      proxyUrl,
      chromePath: args.chrome,
      profileDir: args.profileDir,
      debugPort: args.debugPort,
      bridgePort: args.bridgePort,
      startUrl: provider.startUrl,
      pageUrlIncludes: provider.pageUrlIncludes,
      profilePrefix: `${provider.id}-verification`,
      keepProfile: true,
      devtoolsTimeout: Number(args.devtoolsTimeout || 30000),
    });

    const pageState = await runtime.cdp.evaluate(`({
      href: location.href,
      title: document.title,
      lang: document.documentElement.lang,
      country: document.head?.dataset?.ionIpCountry || ""
    })`);
    const readyState = await provider.waitForLoginReady(runtime.cdp, {
      timeoutMs: Number(args.loginTimeout || 60000),
    });
    const inputState = await provider.submitEmail(runtime.cdp, email);
    const fetchResult = await provider.sendVerification(runtime.cdp, email);
    const result = {
      provider: provider.id,
      email,
      pageState,
      readyState,
      inputState,
      fetchResult,
      profileDir: runtime.profileDir,
      debugPort: runtime.debugPort,
      bridge: {
        localProxy: runtime.bridge ? `http://${runtime.bridge.host}:${runtime.bridge.port}` : "",
        upstreamProxy: proxyUrl ? maskProxy(proxyUrl) : "",
      },
      requests: runtime.cdp.interestingRequests(provider.interestingRequestMatcher),
    };
    const outputPath = join(logDir, `${provider.id}-verification-${timestamp()}.json`);
    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    console.log(JSON.stringify({
      provider: provider.id,
      email,
      status: fetchResult.status,
      sent: provider.verificationWasSent(fetchResult),
      responseText: fetchResult.responseText,
      profileDir: runtime.profileDir,
      debugPort: runtime.debugPort,
      localProxy: result.bridge.localProxy,
      outputPath,
    }, null, 2));

    if (keepOpen) {
      runtime.cdp.close();
      console.log("Chrome 和代理桥将继续运行，完成后请手动关闭 Chrome。");
      await waitForBrowserStop(runtime.chrome);
    }
  } finally {
    await runtime?.close();
  }
}

function printHelp() {
  console.log(`
用法：
  node src/commands/send-verification.js [选项]

选项：
  --provider <名称>      注册服务适配器，优先于统一配置。
  --email <邮箱>         接收邮箱验证信息的邮箱，默认随机生成。
  --domain <域名>        随机邮箱后缀，优先于统一配置。
  --proxy <代理地址>     上游认证代理，优先于 config/app.local.json。
  --no-proxy             本次发送不使用代理。
  --chrome <路径>        Chrome 或 Chromium 可执行文件。
  --bridge-port <端口>   本地代理桥端口，默认随机。
  --debug-port <端口>    Chrome DevTools 端口，默认随机。
  --profile-dir <路径>   Chrome 用户目录。
  --log-dir <路径>       结果目录，默认 ./logs。
  --no-keep-open         发送完成后关闭 Chrome 和代理桥。
  --help                 显示帮助。
`);
}

if (isCliEntry(import.meta.url)) {
  runSendVerificationCommand().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
