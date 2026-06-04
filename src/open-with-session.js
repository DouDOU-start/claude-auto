import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseProxyUrl, startProxyBridge } from "./proxy-bridge.js";
import { CdpClient, findClaudePage } from "./cdp-client.js";
import { resolveBrowserPath } from "./browser-utils.js";
import { resolveProxyUrl } from "./config.js";

const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.sessionKey) {
    printHelp();
    return;
  }

  const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const chromePath = resolveBrowserPath({
    requestedPath: args.chrome,
    projectRoot,
    fallbackPath: DEFAULT_CHROME,
  });

  const proxyUrl = resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });
  const upstream = parseProxyUrl(proxyUrl);
  const debugPort = Number(args.debugPort || 0) || randomPortHint();
  const profileDir = resolve(
    args.profileDir ||
      join(projectRoot, "profiles", `session-${timestamp()}-${randomBytes(4).toString("hex")}`),
  );
  const targetUrl = args.url || "https://claude.ai/chat";

  await mkdir(join(profileDir, "Default"), { recursive: true });
  await writeEnglishProfile(profileDir);

  console.log("[1/4] Starting local proxy bridge...");
  const bridge = await startProxyBridge({
    listenHost: "127.0.0.1",
    listenPort: Number(args.bridgePort || 0),
    upstream,
  });

  console.log("[2/4] Opening fresh Chrome profile...");
  const chrome = launchChrome({
    chromePath,
    profileDir,
    proxyServer: `http://${bridge.host}:${bridge.port}`,
    debugPort,
    url: "https://claude.ai/",
  });

  let cdp;
  try {
    await waitForDevTools(debugPort, 30000);
    cdp = await connectPage(debugPort);

    console.log("[3/4] Setting sessionKey cookie...");
    await setClaudeCookie(cdp, {
      name: "sessionKey",
      value: args.sessionKey,
      httpOnly: true,
    });
    if (args.sessionKeyLc) {
      await setClaudeCookie(cdp, {
        name: "sessionKeyLC",
        value: args.sessionKeyLc,
        httpOnly: false,
      });
    }
    if (args.routingHint) {
      await setClaudeCookie(cdp, {
        name: "routingHint",
        value: args.routingHint,
        httpOnly: true,
      });
    }

    console.log("[4/4] Navigating with injected session...");
    await cdp.send("Page.enable").catch(() => {});
    await cdp.send("Page.navigate", { url: targetUrl });
    await wait(10000);
    const state = await cdp.evaluate(`({
      href: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 3000) || ""
    })`);
    console.log(JSON.stringify({
      profileDir,
      debugPort,
      localProxy: `http://${bridge.host}:${bridge.port}`,
      state,
    }, null, 2));
    console.log("Chrome and proxy bridge are kept running. Close Chrome manually when finished.");
  } finally {
    cdp?.close();
    if (args.noKeepOpen) {
      chrome.kill();
      await bridge.close();
    }
  }
}

async function connectPage(debugPort) {
  const page = await findClaudePage(debugPort);
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  return cdp;
}

async function setClaudeCookie(cdp, { name, value, httpOnly }) {
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
  if (!result.success) throw new Error(`Failed to set cookie: ${name}`);
}

function launchChrome({ chromePath, profileDir, proxyServer, debugPort, url }) {
  return spawn(chromePath, [
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
    url,
  ], { detached: true, stdio: "ignore" });
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
  const localState = { intl: { app_locale: "en-US" }, browser: { enabled_labs_experiments: [] } };
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
    else if (item === "--no-keep-open") args.noKeepOpen = true;
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
  node src/open-with-session.js --session-key <sessionKey> [options]

Options:
  --session-key <value>    Required. sessionKey cookie value.
  --session-key-lc <value> Optional. sessionKeyLC cookie value.
  --routing-hint <value>   Optional. routingHint cookie value.
  --url <url>              URL to open after injecting cookies. Default: https://claude.ai/chat
  --proxy <proxy-url>      Upstream auth proxy. Overrides config/proxy.json.
  --chrome <path>          Chrome/Chromium executable path. Default: bundled Chromium.
  --profile-dir <path>     Chrome profile directory. Default: ./profiles/session-...
  --bridge-port <port>     Local no-auth proxy bridge port. Default: random.
  --debug-port <port>      Chrome DevTools port. Default: random high port.
  --no-keep-open           Close Chrome and proxy bridge after navigation.
  --help                   Show this help.

Example:
  node src/open-with-session.js --session-key "sk-ant-sid02-..."
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
