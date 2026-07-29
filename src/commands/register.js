import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs, isCliEntry } from "../core/cli.js";
import { projectRootFrom, waitForBrowserStop } from "../core/browser-runtime.js";
import { registrationResultSummary, runRegistration } from "../core/registration-runner.js";
import { resolveProxyUrl } from "../config.js";
import { getRegistrationProvider } from "../providers/index.js";
import { defaultClaudeBirthday } from "../providers/claude/profile.js";

export async function runRegisterCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const projectRoot = projectRootFrom(import.meta.url);
  const provider = getRegistrationProvider(args.provider);
  const proxyUrl = resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });
  const email = args.email || `student-${randomBytes(5).toString("hex")}@${args.domain || "k9ray.com"}`;
  const profile = provider.createProfile({ name: args.name, birthday: args.birthday });
  const rl = createInterface({ input, output });

  try {
    const outcome = await runRegistration({
      provider,
      projectRoot,
      email,
      profile,
      proxyUrl,
      chromePath: args.chrome,
      profileDir: args.profileDir,
      logDir: args.logDir,
      debugPort: args.debugPort,
      bridgePort: args.bridgePort,
      devtoolsTimeout: Number(args.devtoolsTimeout || 30000),
      loginTimeout: Number(args.loginTimeout || 90000),
      keepOpen: Boolean(args.keepOpen),
      keepOpenOnError: Boolean(args.keepOpenOnError),
      getVerificationUrl: () => askNonEmpty(rl, "Magic Link 地址："),
      onEvent: printRegistrationEvent,
    });

    if (outcome.status === "blocked") {
      process.exitCode = 1;
      console.error(`错误：${outcome.blocked.reason}`);
      console.error("当前步骤需要人工处理，Chrome 和代理桥将继续运行；按 Ctrl+C 停止。");
      await waitForBrowserStop(outcome.runtime.chrome);
      await outcome.runtime.close();
      return;
    }

    console.log(JSON.stringify(registrationResultSummary(outcome.result), null, 2));
    console.log(`总耗时：${outcome.result.durationText}`);
    if (outcome.keptOpen) {
      console.log("Chrome 和代理桥将继续运行，完成后请手动关闭 Chrome。");
      await waitForBrowserStop(outcome.runtime.chrome);
      await outcome.runtime.close();
    } else {
      console.log("Chrome 和代理桥已关闭。");
    }
  } finally {
    rl.close();
  }
}

function printRegistrationEvent(event) {
  if (event.type === "progress") {
    console.log(`[${event.step}/${event.total}] ${event.message}`);
    return;
  }
  if (event.type === "runtime_ready") {
    console.log(`      用户目录：${event.profileDir}`);
    console.log(`      DevTools 端口：${event.debugPort}`);
    if (event.localProxy) console.log(`      本地代理：${event.localProxy}`);
    return;
  }
  if (event.type === "verification_sent") {
    console.log(JSON.stringify({
      email: event.email,
      sent: event.sent,
      status: event.status,
      responseText: event.responseText,
    }, null, 2));
  }
}

async function askNonEmpty(rl, question) {
  while (true) {
    const answer = (await rl.question(question)).trim();
    if (answer) return answer;
  }
}

function printHelp() {
  console.log(`
用法：
  node src/commands/register.js [选项]

选项：
  --provider <名称>       注册服务适配器，当前支持 claude。
  --email <邮箱>          注册邮箱，默认随机生成 @k9ray.com 邮箱。
  --domain <域名>         随机邮箱域名，默认 k9ray.com。
  --name <姓名>           显示名称，默认随机英文姓名。
  --birthday <MM/DD/YYYY> 新用户引导生日，默认 ${defaultClaudeBirthday()}。
  --proxy <代理地址>      上游认证代理，优先于 config/app.local.json。
  --chrome <路径>         Chrome 或 Chromium 可执行文件。
  --bridge-port <端口>    本地代理桥端口，默认随机。
  --debug-port <端口>     Chrome DevTools 端口，默认随机。
  --profile-dir <路径>    Chrome 用户目录。
  --log-dir <路径>        结果目录，默认 ./logs。
  --keep-open             完成后保留 Chrome 和代理桥。
  --keep-open-on-error    仅在需要人工处理时保留 Chrome。
  --help                  显示帮助。
`);
}

if (isCliEntry(import.meta.url)) {
  runRegisterCommand().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
