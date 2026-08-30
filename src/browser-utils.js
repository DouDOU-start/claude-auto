import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_BROWSER_SEARCH_DEPTH = 6;

export function resolveBrowserPath({
  requestedPath = "",
  configuredPath = "",
  projectRoot,
  fallbackPath = "",
  autoInstall = true,
  env = process.env,
}) {
  const explicitPath =
    requestedPath || env.APP_BROWSER_PATH || env.CLAUDE_BROWSER_PATH || configuredPath || "";
  if (explicitPath) {
    if (existsSync(explicitPath)) return explicitPath;
    throw new Error(`配置的浏览器可执行文件不存在：${explicitPath}`);
  }

  const projectBrowser = firstExisting(projectBrowserCandidates(projectRoot));
  if (projectBrowser) return projectBrowser;

  let installError = null;
  if (
    autoInstall &&
    projectRoot &&
    env.APP_SKIP_BROWSER_DOWNLOAD !== "1" &&
    env.CLAUDE_SKIP_BROWSER_DOWNLOAD !== "1"
  ) {
    try {
      return installProjectBrowser(projectRoot);
    } catch (error) {
      installError = error;
      console.warn(`[浏览器] Chromium 自动下载失败：${error.message}`);
    }
  }

  const fallbackBrowser = firstExisting([...playwrightBrowserCandidates(), fallbackPath].filter(Boolean));
  if (fallbackBrowser) return fallbackBrowser;

  const installHint = installError ? `最近一次安装错误：${installError.message}。` : "";
  throw new Error(
    [
      "未找到浏览器可执行文件。",
      "脚本首次运行时可以自动将 Chromium 下载到 ./browsers。",
      "可执行 `npm run install-browser` 手动安装，",
      "也可以传入 --chrome <路径>，",
      "或设置 APP_BROWSER_PATH（兼容 CLAUDE_BROWSER_PATH）。",
      "还可以在 config/app.local.json 中设置 browser.path。",
      installHint,
    ].join(" "),
  );
}

export function installProjectBrowser(projectRoot) {
  const browsersDir = join(projectRoot, "browsers");
  console.log(`[浏览器] 项目中未找到 Chromium，正在下载到 ${browsersDir}……`);

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
    throw new Error(`playwright install chromium 退出码为 ${result.status}`);
  }

  const installedBrowser = firstExisting(projectBrowserCandidates(projectRoot));
  if (!installedBrowser) {
    throw new Error("Chromium 下载完成，但 ./browsers 中没有找到浏览器可执行文件。");
  }

  console.log(`[浏览器] Chromium 已就绪：${installedBrowser}`);
  return installedBrowser;
}

function installCommand() {
  const args = ["npx", "--yes", "playwright@latest", "install", "chromium"];
  if (process.platform === "win32") {
    return ["cmd.exe", ["/d", "/s", "/c", args.join(" ")]];
  }
  return [args[0], args.slice(1)];
}

export function projectBrowserCandidates(projectRoot, platform = process.platform) {
  const root = join(projectRoot, "browsers");
  if (!existsSync(root)) return [];

  const candidates = [];
  collectChromeExecutables(root, candidates, 0, browserExecutableNames(platform));
  return candidates.sort((a, b) => b.localeCompare(a));
}

export function playwrightBrowserCandidates() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ms-playwright") : "",
    process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "Local", "ms-playwright") : "",
  ].filter(Boolean);

  const candidates = [];
  const executableNames = browserExecutableNames(process.platform);
  for (const root of roots) {
    if (existsSync(root)) collectChromeExecutables(root, candidates, 0, executableNames);
  }
  return [...new Set(candidates)].sort((a, b) => b.localeCompare(a));
}

function collectChromeExecutables(dir, candidates, depth, executableNames) {
  if (depth > MAX_BROWSER_SEARCH_DEPTH) return;

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
      collectChromeExecutables(path, candidates, depth + 1, executableNames);
      continue;
    }
    if (executableNames.has(entry.toLowerCase())) {
      candidates.push(path);
    }
  }
}

function firstExisting(candidates) {
  return candidates.find((candidate) => existsSync(candidate)) || "";
}

function browserExecutableNames(platform) {
  if (platform === "win32") return new Set(["chrome.exe"]);
  if (platform === "darwin") {
    return new Set(["chromium", "google chrome", "google chrome for testing"]);
  }
  return new Set(["chrome", "chromium", "google-chrome", "google-chrome-stable"]);
}
