import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseMailAccountLine, pollClaudeMagicLink } from "./mailbox.js";

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
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
    throw new Error("No mail accounts provided.");
  }

  const results = [];
  for (let index = 0; index < accounts.length; index += 1) {
    const account = accounts[index];
    console.log(`[account ${index + 1}/${accounts.length}] Registering ${account.email}`);
    const result = await runAutoRegistrationWithRetries({ account, args });
    results.push(result);
  }

  console.log(JSON.stringify({ completed: results.length, results }, null, 2));
}

async function runAutoRegistrationWithRetries({ account, args }) {
  const maxAttempts = Number(args.maxAttempts || 3);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) console.log(`[retry] Attempt ${attempt}/${maxAttempts} for ${account.email}`);
    try {
      return await runAutoRegistration({ account, args, attempt });
    } catch (error) {
      lastError = error;
      if (!isRetryableRegistrationError(error) || attempt === maxAttempts) throw error;
      console.log(`[retry] ${error.message}`);
      await wait(Number(args.retryDelay || 3000));
    }
  }

  throw lastError || new Error(`Registration failed for ${account.email}.`);
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
    console.log(`[mail] Polling ${account.email} for Claude magic link...`);
    const mail = await pollClaudeMagicLink({
      account,
      since: new Date(startedAt.getTime() - 30000),
      timeoutMs: Number(args.mailTimeout || 180000),
      intervalMs: Number(args.mailInterval || 5000),
      log: (message) => console.log(`[mail] ${message}`),
    });
    magicLink = mail.magicLink;
    if (!magicLink) throw new Error("Mail polling returned without a magic link.");
    console.log(`[mail] Found Claude magic link via ${mail.mode}.`);
    child.stdin.write(`${magicLink}\n`);
  };

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
    if (stdout.includes("Magic link URL:")) {
      sendMagicLinkWhenReady().catch((error) => {
        pollingError = error;
        console.error(`ERROR: ${error.message}`);
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
      reason: "Phone verification required",
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
      throw new Error(`Mail polling failed for ${account.email}. ${pollingError.message}`);
    }
    if (args.keepOpenOnError) {
      if (!isManualOnboardingText(errorText)) {
        throw new Error(`Registration process failed for ${account.email} with exit code ${exitResult.code}. ${summarizeFailure(errorText)}`);
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
    throw new Error(`Registration process failed for ${account.email} with exit code ${exitResult.code}. ${summarizeFailure(errorText)}`);
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
Usage:
  node src/auto-register-mail.js --account "<email>----<password>----<client_id>----<refresh_token>" [options]
  node src/auto-register-mail.js --accounts-file accounts.txt [options]

Options:
  --account <line>         One account line: email----password----client_id----refresh_token.
  --accounts-file <path>   File with one account line per row.
  --mail-timeout <ms>      Mail polling timeout. Default: 180000.
  --mail-interval <ms>     Mail polling interval. Default: 5000.
  --max-attempts <n>       Retry count for proxy/login failures. Default: 3.
  --retry-delay <ms>       Delay between retry attempts. Default: 3000.
  --registration-timeout <ms> Parent process timeout. Default: 600000.
  --devtools-timeout <ms>  Child DevTools timeout. Default: 30000.
  --login-timeout <ms>     Child Claude login timeout. Default: 90000.
  --name <name>            Optional Claude display name.
  --birthday <MM/DD/YYYY>  Optional birthday. Default comes from interactive-register.js.
  --proxy <proxy-url>      Optional proxy override.
  --chrome <path>          Optional browser override.
  --keep-open              Keep browser open after registration.
  --keep-open-on-error     Keep browser open when onboarding needs manual action.
  --help                   Show this help.
`);
}

function isRetryableRegistrationError(error) {
  return /Claude login page not ready|ERR_TUNNEL_CONNECTION_FAILED|DevTools port did not open|tunnel|proxy/i.test(error?.message || "");
}

function isManualOnboardingText(text) {
  return /Phone verification required/i.test(text || "");
}

function summarizeFailure(text) {
  const value = String(text || "");
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(value)) return "Detected proxy tunnel failure.";
  if (/Claude login page not ready/i.test(value)) return "Claude login page was not ready, likely proxy or Cloudflare loading failure.";
  if (/Phone verification required/i.test(value)) return "Phone verification required.";
  return value.split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 800);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
