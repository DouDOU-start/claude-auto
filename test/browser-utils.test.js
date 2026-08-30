import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { projectBrowserCandidates, resolveBrowserPath } from "../src/browser-utils.js";

test("浏览器路径按命令行、环境变量、统一配置和项目目录依次选择", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "browser-utils-priority-test-"));
  const requested = join(projectRoot, "configured", "requested-browser");
  const appEnvironment = join(projectRoot, "configured", "app-environment-browser");
  const legacyEnvironment = join(projectRoot, "configured", "legacy-environment-browser");
  const configured = join(projectRoot, "configured", "app-local-browser");
  const projectBrowserName =
    process.platform === "win32" ? "chrome.exe" : process.platform === "darwin" ? "Chromium" : "chrome";
  const projectBrowser = join(projectRoot, "browsers", "chromium-1234", projectBrowserName);

  try {
    await Promise.all(
      [requested, appEnvironment, legacyEnvironment, configured, projectBrowser].map(createExecutable),
    );
    const baseOptions = {
      configuredPath: configured,
      projectRoot,
      fallbackPath: "",
      autoInstall: false,
    };

    assert.equal(
      resolveBrowserPath({
        ...baseOptions,
        requestedPath: requested,
        env: {
          APP_BROWSER_PATH: appEnvironment,
          CLAUDE_BROWSER_PATH: legacyEnvironment,
        },
      }),
      requested,
    );
    assert.equal(
      resolveBrowserPath({
        ...baseOptions,
        env: {
          APP_BROWSER_PATH: appEnvironment,
          CLAUDE_BROWSER_PATH: legacyEnvironment,
        },
      }),
      appEnvironment,
    );
    assert.equal(
      resolveBrowserPath({
        ...baseOptions,
        env: { CLAUDE_BROWSER_PATH: legacyEnvironment },
      }),
      legacyEnvironment,
    );
    assert.equal(resolveBrowserPath({ ...baseOptions, env: {} }), configured);
    assert.equal(
      resolveBrowserPath({ ...baseOptions, configuredPath: "", env: {} }),
      projectBrowser,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("Windows 会发现项目 browsers 目录中的 Playwright Chrome", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "browser-utils-windows-test-"));
  const executable = join(
    projectRoot,
    "browsers",
    "chromium-1234",
    "chrome-win64",
    "chrome.exe",
  );

  try {
    await createExecutable(executable);
    assert.deepEqual(projectBrowserCandidates(projectRoot, "win32"), [executable]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("macOS 会发现项目 browsers 目录中的 Chrome for Testing", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "browser-utils-macos-test-"));
  const executable = join(
    projectRoot,
    "browsers",
    "chromium-1234",
    "chrome-mac-arm64",
    "Google Chrome for Testing.app",
    "Contents",
    "MacOS",
    "Google Chrome for Testing",
  );

  try {
    await createExecutable(executable);
    assert.deepEqual(projectBrowserCandidates(projectRoot, "darwin"), [executable]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("macOS 兼容项目中的旧版 Chromium 可执行文件名", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "browser-utils-chromium-test-"));
  const executable = join(
    projectRoot,
    "browsers",
    "chromium-1234",
    "Chromium.app",
    "Contents",
    "MacOS",
    "Chromium",
  );

  try {
    await createExecutable(executable);
    assert.deepEqual(projectBrowserCandidates(projectRoot, "darwin"), [executable]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function createExecutable(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
}
