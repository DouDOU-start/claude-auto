import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function resolveBrowserPath({ requestedPath = "", projectRoot, fallbackPath = "", autoInstall = true }) {
  const explicitPath = requestedPath || process.env.CLAUDE_BROWSER_PATH || "";
  if (explicitPath) {
    if (existsSync(explicitPath)) return explicitPath;
    throw new Error(`Configured browser executable does not exist: ${explicitPath}`);
  }

  const projectBrowser = firstExisting(projectBrowserCandidates(projectRoot));
  if (projectBrowser) return projectBrowser;

  let installError = null;
  if (autoInstall && projectRoot && process.env.CLAUDE_SKIP_BROWSER_DOWNLOAD !== "1") {
    try {
      return installProjectBrowser(projectRoot);
    } catch (error) {
      installError = error;
      console.warn(`[browser] Automatic Chromium download failed: ${error.message}`);
    }
  }

  const fallbackBrowser = firstExisting([...playwrightBrowserCandidates(), fallbackPath].filter(Boolean));
  if (fallbackBrowser) return fallbackBrowser;

  const installHint = installError ? ` Last install error: ${installError.message}.` : "";
  throw new Error(
    [
      "No browser executable found.",
      "The script can automatically download Chromium into ./browsers on first run.",
      "Run `npm run install-browser` to install it manually,",
      "pass --chrome <path>,",
      "or set CLAUDE_BROWSER_PATH.",
      installHint,
    ].join(" "),
  );
}

export function installProjectBrowser(projectRoot) {
  const browsersDir = join(projectRoot, "browsers");
  console.log(`[browser] Chromium not found in project browsers. Downloading to ${browsersDir} ...`);

  const result = spawnSync(...installCommand(), {
    cwd: projectRoot,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: browsersDir,
    },
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(result.error.message);
  }
  if (result.status !== 0) {
    throw new Error(`playwright install chromium exited with code ${result.status}`);
  }

  const installedBrowser = firstExisting(projectBrowserCandidates(projectRoot));
  if (!installedBrowser) {
    throw new Error("Chromium download finished, but no browser executable was found in ./browsers.");
  }

  console.log(`[browser] Chromium ready: ${installedBrowser}`);
  return installedBrowser;
}

function installCommand() {
  const args = ["npx", "--yes", "playwright@latest", "install", "chromium"];
  if (process.platform === "win32") {
    return ["cmd.exe", ["/d", "/s", "/c", args.join(" ")]];
  }
  return [args[0], args.slice(1)];
}

export function projectBrowserCandidates(projectRoot) {
  const root = join(projectRoot, "browsers");
  if (!existsSync(root)) return [];

  const candidates = [];
  collectChromeExecutables(root, candidates, 0);
  return candidates.sort((a, b) => b.localeCompare(a));
}

export function playwrightBrowserCandidates() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local", "ms-playwright") : "",
  ].filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    if (existsSync(root)) collectChromeExecutables(root, candidates, 0);
  }
  return [...new Set(candidates)].sort((a, b) => b.localeCompare(a));
}

function collectChromeExecutables(dir, candidates, depth) {
  if (depth > 4) return;

  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const path = join(dir, entry);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      collectChromeExecutables(path, candidates, depth + 1);
      continue;
    }
    if (entry.toLowerCase() === chromeExecutableName()) {
      candidates.push(path);
    }
  }
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function chromeExecutableName() {
  return process.platform === "win32" ? "chrome.exe" : process.platform === "darwin" ? "Chromium" : "chrome";
}
