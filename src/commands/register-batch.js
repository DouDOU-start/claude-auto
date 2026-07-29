import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs, isCliEntry } from "../core/cli.js";
import { projectRootFrom } from "../core/browser-runtime.js";
import { registrationResultSummary, runRegistration } from "../core/registration-runner.js";
import { waitWithSignal } from "../core/abort.js";
import {
  resolveCliProxyXaiOAuth,
  resolveProxyUrl,
  resolveRegistrationProviderId,
} from "../config.js";
import { parseMailAccountLine } from "../mail/account.js";
import { getRegistrationProvider } from "../providers/index.js";

export async function runRegisterBatchCommand(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }

  const accounts = await loadAccounts(args);
  if (!accounts.length) {
    printHelp();
    throw new Error("没有提供邮箱账号。");
  }

  const projectRoot = projectRootFrom(import.meta.url);
  const provider = getRegistrationProvider(
    resolveRegistrationProviderId({ requestedProvider: args.provider, projectRoot }),
  );
  const proxyUrl = args.noProxy ? "" : resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });
  const authorization = provider.id === "grok"
    ? resolveCliProxyXaiOAuth({
        requestedEnabled: args.noXaiOauth ? false : args.xaiOauth ? true : undefined,
        requestedUseProxy: args.noXaiOauthProxy
          ? false
          : args.xaiOauthProxy
            ? true
            : undefined,
        requestedAuthDir: args.cliproxyAuthDir,
        projectRoot,
      })
    : { enabled: false };
  const results = [];

  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    console.log(`[账号 ${index + 1}/${accounts.length}] 正在注册 ${account.email}`);
    results.push(await runWithRetries({
      account,
      args,
      projectRoot,
      provider,
      proxyUrl,
      authorization,
    }));
  }

  console.log(JSON.stringify({ completed: results.length, results }, null, 2));
}

async function runWithRetries(context) {
  const maxAttempts = Number(context.args.maxAttempts || 3);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      console.log(`[重试] ${context.account.email} 第 ${attempt}/${maxAttempts} 次尝试`);
    }
    try {
      return await runSingleRegistration({ ...context, attempt });
    } catch (error) {
      lastError = error;
      if (!context.provider.isRetryableError(error) || attempt === maxAttempts) throw error;
      console.log(`[重试] ${context.provider.summarizeError(error)}`);
      await waitWithSignal(Number(context.args.retryDelay || 3000));
    }
  }

  throw lastError || new Error(`${context.account.email} 注册失败。`);
}

async function runSingleRegistration({
  account,
  args,
  projectRoot,
  provider,
  proxyUrl,
  authorization,
  attempt,
}) {
  const startedAt = new Date();
  const controller = new AbortController();
  const timeoutMs = Number(args.registrationTimeout || 600000);
  const timeout = setTimeout(() => {
    controller.abort(new Error(`${account.email} 注册超时，已超过 ${timeoutMs} 毫秒。`));
  }, timeoutMs);
  let verificationFound = false;

  try {
    const outcome = await runRegistration({
      provider,
      projectRoot,
      email: account.email,
      profile: provider.createProfile({
        name: args.name,
        givenName: args.givenName,
        familyName: args.familyName,
        password: args.password,
        birthday: args.birthday,
      }),
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
      authorization,
      signal: controller.signal,
      getVerification: async () => {
        const verificationLabel = provider.verificationLabel || "邮箱验证信息";
        console.log(`[邮件] 正在轮询 ${account.email} 中的 ${provider.displayName} ${verificationLabel}……`);
        const mail = await provider.pollVerification({
          account,
          since: new Date(startedAt.getTime() - 30000),
          timeoutMs: Number(args.mailTimeout || 180000),
          intervalMs: Number(args.mailInterval || 5000),
          signal: controller.signal,
          log: (message) => console.log(`[邮件] ${message}`),
        });
        const verification = mail.verification || mail.verificationUrl || "";
        verificationFound = Boolean(verification);
        if (verificationFound) {
          console.log(`[邮件] 已通过 ${mail.mode} 找到 ${provider.displayName} ${verificationLabel}。`);
        }
        return verification;
      },
      onEvent: printRegistrationEvent,
    });

    if (outcome.status === "blocked") {
      return {
        provider: provider.id,
        email: account.email,
        verificationFound,
        magicLinkFound: verificationFound,
        attempt,
        exitCode: null,
        blocked: true,
        reason: outcome.blocked.reason,
        profileDir: outcome.blocked.profileDir,
        debugPort: outcome.blocked.debugPort,
        stderr: "",
      };
    }

    return {
      provider: provider.id,
      email: account.email,
      verificationFound,
      magicLinkFound: verificationFound,
      attempt,
      exitCode: 0,
      keptOpen: outcome.keptOpen,
      outputSummary: registrationResultSummary(outcome.result),
      stderr: "",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function loadAccounts(args) {
  if (args.account) return [parseMailAccountLine(args.account)];
  if (args.accountsFile) {
    const content = await readFile(resolve(args.accountsFile), "utf8");
    return content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(parseMailAccountLine);
  }
  return [];
}

function printRegistrationEvent(event) {
  if (event.type === "progress") {
    console.log(`[${event.step}/${event.total}] ${event.message}`);
    return;
  }
  if (event.type === "verification_sent") {
    console.log(JSON.stringify({
      email: event.email,
      sent: event.sent,
      status: event.status,
      responseText: event.responseText,
    }, null, 2));
    return;
  }
  if (event.type === "runtime_ready") {
    console.log(`      用户目录：${event.profileDir}`);
    console.log(`      DevTools 端口：${event.debugPort}`);
    if (event.localProxy) console.log(`      本地代理：${event.localProxy}`);
  }
}

function printHelp() {
  console.log(`
用法：
  node src/commands/register-batch.js --account "<email>----<password>----<client_id>----<refresh_token>" [选项]
  node src/commands/register-batch.js --accounts-file accounts.txt [选项]

选项：
  --provider <名称>       注册服务适配器，优先于统一配置。
  --account <账号行>      单个账号：email----password----client_id----refresh_token。
  --accounts-file <路径>  每行一个账号的文件。
  --mail-timeout <毫秒>   邮件轮询超时，默认 180000。
  --mail-interval <毫秒>  邮件轮询间隔，默认 5000。
  --max-attempts <次数>   代理或登录失败重试次数，默认 3。
  --retry-delay <毫秒>    重试间隔，默认 3000。
  --registration-timeout <毫秒> 注册总超时，默认 600000。
  --devtools-timeout <毫秒> DevTools 启动超时，默认 30000。
  --login-timeout <毫秒>  登录页超时，默认 90000。
  --name <姓名>           可选的显示名称。
  --given-name <名字>     Grok 注册名字。
  --family-name <姓氏>    Grok 注册姓氏。
  --password <密码>       Grok 注册密码，默认随机生成。
  --birthday <MM/DD/YYYY> 可选生日。
  --proxy <代理地址>      可选代理覆盖。
  --no-proxy              本次注册不使用代理。
  --chrome <路径>         可选浏览器覆盖。
  --xai-oauth             Grok 注册后执行 xAI OAuth 授权。
  --no-xai-oauth          Grok 注册后不执行 xAI OAuth 授权。
  --cliproxy-auth-dir <路径> CLIProxy 认证文件输出目录。
  --xai-oauth-proxy       xAI OAuth 协议请求使用注册代理。
  --no-xai-oauth-proxy    xAI OAuth 协议请求使用直连。
  --keep-open             注册后保留浏览器。
  --keep-open-on-error    需要人工处理时保留浏览器。
  --help                  显示帮助。
`);
}

if (isCliEntry(import.meta.url)) {
  runRegisterBatchCommand().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
