import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { startProxyBridge, parseProxyUrl } from "./proxy-bridge.js";
import { CdpClient, findClaudePage } from "./cdp-client.js";
import { resolveBrowserPath } from "./browser-utils.js";
import { maskProxy, resolveProxyUrl } from "./config.js";

const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
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
  await writeEnglishProfile(profileDir);

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
      chrome.kill();
      await bridge.close();
    } else {
      console.log("Chrome and proxy bridge are kept running. Close Chrome manually when finished.");
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
      // The page can replace its execution context while Cloudflare/Claude loads.
    }
    await wait(500);
  }
  throw new Error(`Claude login page was not ready before timeout. Last state: ${JSON.stringify(lastState)}`);
}

async function syncVisibleEmailInput(cdp, email) {
  return cdp.evaluate(`
    (() => {
      const input = document.querySelector('input#email, input[type="email"], input[data-testid="email"]');
      if (!input) return { ok: false, reason: "email input not found" };
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

function launchChrome({ chromePath, profileDir, proxyServer, debugPort }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-save-password-bubble",
    "--lang=en-US",
    "--accept-lang=en-US,en",
    "--timezone=America/New_York",
    "--new-window",
    `--proxy-server=${proxyServer}`,
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "https://claude.ai/login",
  ];
  return spawn(chromePath, args, { detached: true, stdio: "ignore" });
}

async function writeEnglishProfile(profileDir) {
  const prefs = {
    autofill: { credit_card_enabled: false, profile_enabled: false },
    credentials_enable_service: false,
    intl: { accept_languages: "en-US,en" },
    payments: { can_make_payment_enabled: false },
    profile: { password_manager_enabled: false },
    webkit: { webprefs: { default_encoding: "UTF-8" } },
  };
  const localState = {
    intl: { app_locale: "en-US" },
    browser: { enabled_labs_experiments: [] },
  };
  await writeFile(join(profileDir, "Default", "Preferences"), JSON.stringify(prefs, null, 2), "utf8");
  await writeFile(join(profileDir, "Local State"), JSON.stringify(localState, null, 2), "utf8");
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await wait(300);
  }
  throw new Error(`DevTools port did not open: ${port}`);
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
Usage:
  node src/send-email.js [options]

Options:
  --email <email>          Email to send magic link to. Default: random @k9ray.com.
  --domain <domain>        Random email domain when --email is omitted. Default: k9ray.com.
  --proxy <proxy-url>      Upstream auth proxy. Overrides config/proxy.json.
  --chrome <path>          Chrome/Chromium executable path. Default: bundled Chromium.
  --bridge-port <port>     Local no-auth proxy bridge port. Default: random.
  --debug-port <port>      Chrome DevTools port. Default: random high port.
  --profile-dir <path>     Chrome profile directory. Default: ./profiles/claude-...
  --log-dir <path>         Result JSON directory. Default: ./logs.
  --no-keep-open           Close Chrome and proxy bridge after sending.
  --help                   Show this help.

Example:
  node src/send-email.js --email test-demo@k9ray.com
`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function randomPortHint() {
  return 40000 + Math.floor(Math.random() * 20000);
}

function parseSent(responseText) {
  try {
    return Boolean(JSON.parse(responseText).sent);
  } catch {
    return false;
  }
}
