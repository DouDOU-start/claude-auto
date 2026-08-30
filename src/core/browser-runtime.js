import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveBrowserPath } from "../browser-utils.js";
import { readAppConfig } from "../config.js";
import { parseProxyUrl, startProxyBridge } from "../proxy-bridge.js";
import { CdpClient, findPage } from "../cdp-client.js";
import { throwIfAborted } from "./abort.js";

const DEFAULT_CHROME =
  process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "linux"
      ? "/usr/bin/google-chrome"
      : "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

export function projectRootFrom(metaUrl) {
  return resolve(new URL("../..", metaUrl).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

export async function openBrowserRuntime({
  projectRoot,
  proxyUrl = "",
  chromePath = "",
  profileDir = "",
  debugPort = 0,
  bridgePort = 0,
  startUrl = "https://claude.ai/",
  pageUrlIncludes = "",
  headless = false,
  profilePrefix = "runtime",
  keepProfile = false,
  devtoolsTimeout = 30000,
  signal,
}) {
  const configuredBrowserPath = readAppConfig(projectRoot).browser?.path || "";
  const executable = resolveBrowserPath({
    requestedPath: chromePath,
    configuredPath: configuredBrowserPath,
    projectRoot,
    fallbackPath: DEFAULT_CHROME,
  });
  const actualProfileDir = resolve(
    profileDir ||
      join(projectRoot, "profiles", `${profilePrefix}-${timestamp()}-${randomBytes(4).toString("hex")}`),
  );
  const actualDebugPort = Number(debugPort) || randomPortHint();

  await mkdir(join(actualProfileDir, "Default"), { recursive: true });
  await writeBrowserProfile(actualProfileDir);

  let bridge = null;
  let chrome = null;
  let cdp = null;
  let closed = false;
  try {
    if (proxyUrl) {
      bridge = await startProxyBridge({
        listenHost: "127.0.0.1",
        listenPort: Number(bridgePort) || 0,
        upstream: parseProxyUrl(proxyUrl),
      });
    }

    chrome = launchChrome({
      chromePath: executable,
      profileDir: actualProfileDir,
      proxyServer: bridge ? `http://${bridge.host}:${bridge.port}` : "",
      debugPort: actualDebugPort,
      url: startUrl,
      headless,
    });
    await waitForDevTools(actualDebugPort, Number(devtoolsTimeout), signal);
    const page = await findPage(actualDebugPort, {
      urlIncludes: pageUrlIncludes || pageUrlHint(startUrl),
    });
    cdp = new CdpClient(page.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Page.enable");

    return {
      cdp,
      chrome,
      bridge,
      chromePath: executable,
      debugPort: actualDebugPort,
      profileDir: actualProfileDir,
      async close() {
        if (closed) return;
        closed = true;
        cdp?.close();
        await stopChrome(chrome);
        await bridge?.close().catch(() => {});
        if (!keepProfile) {
          await rm(actualProfileDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  } catch (error) {
    cdp?.close();
    await stopChrome(chrome);
    await bridge?.close().catch(() => {});
    if (!keepProfile) {
      await rm(actualProfileDir, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}

export function launchChrome({ chromePath, profileDir, proxyServer = "", debugPort, url, headless = false }) {
  const args = [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-save-password-bubble",
    "--lang=en-US",
    "--accept-lang=en-US,en",
    "--timezone=America/New_York",
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
  ];
  if (proxyServer) args.push(`--proxy-server=${proxyServer}`);
  if (headless) {
    args.push("--headless=new", "--disable-gpu", "--window-size=1280,900");
  } else {
    args.push("--new-window");
  }
  args.push(url);
  return spawn(chromePath, args, { detached: true, stdio: "ignore" });
}

export async function writeBrowserProfile(profileDir) {
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
  await writeFileIfMissing(
    join(profileDir, "Default", "Preferences"),
    JSON.stringify(prefs, null, 2),
  );
  await writeFileIfMissing(join(profileDir, "Local State"), JSON.stringify(localState, null, 2));
}

async function writeFileIfMissing(path, content) {
  try {
    await writeFile(path, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

export async function waitForDevTools(port, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await wait(300);
  }
  throwIfAborted(signal);
  throw new Error(`DevTools 端口未能按时启动：${port}`);
}

export async function stopChrome(chrome) {
  if (!chrome?.pid) return;
  if (process.platform === "win32") {
    await runIgnore("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], 7000);
    return;
  }
  try {
    process.kill(-chrome.pid, "SIGTERM");
  } catch {
    try {
      chrome.kill();
    } catch {}
  }
  await wait(500);
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {}
}

function runIgnore(command, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolveRun();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolveRun();
    };
    child.once("exit", done);
    child.once("error", done);
  });
}

export function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

export function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

export function randomPortHint() {
  return 40000 + Math.floor(Math.random() * 20000);
}

export function waitForBrowserStop(chrome) {
  if (!chrome || chrome.exitCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const done = () => {
      chrome.off("exit", done);
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolveStop();
    };
    chrome.once("exit", done);
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
}

function pageUrlHint(startUrl) {
  try {
    const parsed = new URL(startUrl);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.hostname : "";
  } catch {
    return "";
  }
}
