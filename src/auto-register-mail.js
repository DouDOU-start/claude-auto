import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseMailAccountLine, pollClaudeMagicLink } from "./mailbox.js";

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

  const accounts = await loadAccounts(args);
  if (!accounts.length) {
    printHelp();
    throw new Error("没有提供邮箱账号。");
  }

  const results = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    console.log(`[账号 ${index + 1}/${accounts.length}] 正在注册 ${account.email}`);
    const result = await runAutoRegistrationWithRetries({ account, args });
    results.push(result);
  }

  console.log(JSON.stringify({ completed: results.length, results }, null, 2));
}

async function runAutoRegistrationWithRetries({ account, args }) {
  const maxAttempts = Number(args.maxAttempts || 3);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) console.log(`[重试] ${account.email} 第 ${attempt}/${maxAttempts} 次尝试`);
    try {
      return await runAutoRegistration({ account, args, attempt });
    } catch (error) {
      lastError = error;
      if (!isRetryableRegistrationError(error) || attempt === maxAttempts) throw error;
      console.log(`[重试] ${error.message}`);
      await wait(Number(args.retryDelay || 3000));
    }
  }

  throw lastError || new Error(`${account.email} 注册失败。`);
}

async function runAutoRegistration({ account, args, attempt = 1 }) {
  const startedAt = new Date();
  const childArgs = [
    "src/interactive-register.js",
    "--email",
    account.email,
    ...optionalPair("--name", args.name),
    ...optionalPair("--birthday", args.birthday),
    ...optionalPair("--proxy", args.proxy),
    ...optionalPair("--chrome", args.chrome),
    ...optionalPair("--bridge-port", args.bridgePort),
    ...optionalPair("--debug-port", args.debugPort),
    ...optionalPair("--profile-dir", args.profileDir),
    ...optionalPair("--log-dir", args.logDir),
    ...optionalPair("--devtools-timeout", args.devtoolsTimeout),
    ...optionalPair("--login-timeout", args.loginTimeout),
    ...(args.keepOpen ? ["--keep-open"] : []),
    ...(args.keepOpenOnError ? ["--keep-open-on-error"] : []),
  ];

  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let magicLinkSent = false;
  let magicLink = "";
  let pollingError = null;

  const sendMagicLinkWhenReady = async () => {
    if (magicLinkSent) return;
    magicLinkSent = true;
    console.log(`[邮件] 正在轮询 ${account.email} 中的 Claude Magic Link……`);
    const mail = await pollClaudeMagicLink({
      account,
      since: new Date(startedAt.getTime() - 30000),
      timeoutMs: Number(args.mailTimeout || 180000),
      intervalMs: Number(args.mailInterval || 5000),
      log: (message) => console.log(`[邮件] ${message}`),
    });
    magicLink = mail.magicLink;
    if (!magicLink) throw new Error("邮件轮询结束，但没有返回 Magic Link。");
    console.log(`[邮件] 已通过 ${mail.mode} 找到 Claude Magic Link。`);
    child.stdin.write(`${magicLink}\n`);
  };

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
    if (stdout.includes("Magic Link 地址：")) {
      sendMagicLinkWhenReady().catch((error) => {
        pollingError = error;
        console.error(`错误：${error.message}`);
        child.stdin.write("about:blank\n", () => child.stdin.end());
      });
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exitResult = await waitForRegistrationExit({ child, stdoutRef: () => stdout, stderrRef: () => stderr, args });
  if (exitResult.manualBlocked) {
    detachChild(child);
    return {
      email: account.email,
      magicLinkFound: Boolean(magicLink),
      attempt,
      exitCode: null,
      childPid: child.pid,
      blocked: true,
      reason: "需要手机验证",
      stderr: stderr.trim(),
    };
  }

  if (exitResult.keptOpen) {
    detachChild(child);
    return {
      email: account.email,
      magicLinkFound: Boolean(magicLink),
      attempt,
      exitCode: null,
      childPid: child.pid,
      keptOpen: true,
      outputSummary: parseFinalJson(stdout),
      stderr: stderr.trim(),
    };
  }

  if (exitResult.code !== 0) {
    const errorText = `${stdout}\n${stderr}`;
    if (pollingError) {
      throw new Error(`${account.email} 邮件轮询失败：${pollingError.message}`);
    }
    if (args.keepOpenOnError) {
      if (!isManualOnboardingText(errorText)) {
        throw new Error(`${account.email} 注册进程失败，退出码 ${exitResult.code}。${summarizeFailure(errorText)}`);
      }
      return {
        email: account.email,
        magicLinkFound: Boolean(magicLink),
        attempt,
        exitCode: exitResult.code,
        blocked: true,
        stderr: stderr.trim(),
      };
    }
    throw new Error(`${account.email} 注册进程失败，退出码 ${exitResult.code}。${summarizeFailure(errorText)}`);
  }

  return {
    email: account.email,
    magicLinkFound: Boolean(magicLink),
    attempt,
    exitCode: exitResult.code,
    outputSummary: parseFinalJson(stdout),
    stderr: stderr.trim(),
  };
}

function waitForRegistrationExit({ child, stdoutRef, stderrRef, args }) {
  const timeoutMs = Number(args.registrationTimeout || 600000);
  return new Promise((resolveExit) => {
    let resolved = false;
    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      clearInterval(watchTimer);
      clearTimeout(timeoutTimer);
      child.off("exit", onExit);
      resolveExit(result);
    };
    const onExit = (code, signal) => finish({ code, signal });
    const watchTimer = setInterval(() => {
      const text = `${stdoutRef()}\n${stderrRef()}`;
      if (args.keepOpenOnError && isManualOnboardingText(text)) {
        finish({ code: null, signal: null, manualBlocked: true });
        return;
      }
      if (args.keepOpen && parseFinalJson(stdoutRef())) {
        finish({ code: null, signal: null, keptOpen: true });
      }
    }, 500);
    const timeoutTimer = setTimeout(() => {
      child.kill();
      finish({ code: 1, signal: "timeout", timeout: true });
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function detachChild(child) {
  child.stdout?.removeAllListeners("data");
  child.stderr?.removeAllListeners("data");
  child.stdin?.end?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  child.stdin?.destroy?.();
  child.unref?.();
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

function parseFinalJson(stdout) {
  const matches = [...stdout.matchAll(/\{\s*"email"[\s\S]+?\n\}/g)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(matches[index][0]);
      if (parsed.sessionKey || parsed.outputPath) return parsed;
    } catch {}
  }
  return null;
}

function optionalPair(flag, value) {
  return value ? [flag, value] : [];
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) args[key] = true;
      else {
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
  node src/auto-register-mail.js --account "<email>----<password>----<client_id>----<refresh_token>" [options]
  node src/auto-register-mail.js --accounts-file accounts.txt [options]

选项：
  --account <账号行>       单个账号：email----password----client_id----refresh_token。
  --accounts-file <路径>   每行一个账号的文件。
  --mail-timeout <毫秒>    邮件轮询超时，默认 180000。
  --mail-interval <毫秒>   邮件轮询间隔，默认 5000。
  --max-attempts <次数>    代理或登录失败重试次数，默认 3。
  --retry-delay <毫秒>     重试间隔，默认 3000。
  --registration-timeout <毫秒> 父进程超时，默认 600000。
  --devtools-timeout <毫秒> 子进程 DevTools 超时，默认 30000。
  --login-timeout <毫秒>   Claude 登录页超时，默认 90000。
  --name <姓名>            可选的 Claude 显示名称。
  --birthday <MM/DD/YYYY>  可选生日。
  --proxy <代理地址>       可选代理覆盖。
  --chrome <路径>          可选浏览器覆盖。
  --keep-open              注册后保留浏览器。
  --keep-open-on-error     需要人工处理时保留浏览器。
  --help                   显示帮助。
`);
}

function isRetryableRegistrationError(error) {
  return /Claude 登录页未就绪|ERR_TUNNEL_CONNECTION_FAILED|DevTools 端口未能按时启动|隧道|代理/i.test(error?.message || "");
}

function isManualOnboardingText(text) {
  return /需要手机验证/i.test(text || "");
}

function summarizeFailure(text) {
  const value = String(text || "");
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(value)) return "检测到代理隧道失败。";
  if (/Claude 登录页未就绪/i.test(value)) return "Claude 登录页未就绪，可能是代理或 Cloudflare 加载失败。";
  if (/需要手机验证/i.test(value)) return "需要手机验证。";
  return value.split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 800);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
