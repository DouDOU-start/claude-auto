import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadClaudeConfig, splitSessionKeys } from "../src/claude/config.js";
import {
  resolveCliProxyXaiOAuth,
  resolveProxyUrl,
  resolveRandomEmailDomain,
  resolveRegistrationProviderId,
} from "../src/config.js";

test("会话密钥支持数组、逗号和换行，并自动去重", () => {
  assert.deepEqual(splitSessionKeys("a, b\na"), ["a", "b"]);
  assert.deepEqual(splitSessionKeys(["a", " b ", ""]), ["a", "b"]);
});

test("统一 JSON 配置能够加载全部运行参数", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "claude-config-test-"));
  try {
    await mkdir(join(projectRoot, "config"));
    await writeFile(
      join(projectRoot, "config", "app.local.json"),
      JSON.stringify({
        proxy: { url: "http://user:pass@example.com:8080" },
        browser: { path: "/browser", headless: false },
        mail: { randomDomain: "mail.example.com" },
        registration: { provider: "grok" },
        cliproxy: {
          xaiOAuthAfterRegistration: true,
          xaiOAuthUseProxy: true,
          authDir: "/tmp/cliproxy-auths",
        },
        providers: {
          claude: { sessionKeys: ["abc"], model: "model", effort: "high" },
        },
        api: { host: "localhost", port: 9000, key: "key" },
      }),
      "utf8",
    );
    const config = loadClaudeConfig({ projectRoot, env: { DISPLAY: "1" } });
    assert.equal(config.proxyUrl, "http://user:pass@example.com:8080");
    assert.deepEqual(config.sessionKeys, ["abc"]);
    assert.equal(config.browserPath, "/browser");
    assert.equal(config.headless, false);
    assert.equal(config.model, "model");
    assert.equal(config.effort, "high");
    assert.equal(config.host, "localhost");
    assert.equal(config.port, 9000);
    assert.equal(config.apiKey, "key");
    assert.equal(resolveRandomEmailDomain({ projectRoot, env: {} }), "mail.example.com");
    assert.equal(resolveRegistrationProviderId({ projectRoot, env: {} }), "grok");
    assert.deepEqual(resolveCliProxyXaiOAuth({ projectRoot, env: {} }), {
      enabled: true,
      authDir: "/tmp/cliproxy-auths",
      useProxy: true,
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("旧版 Claude 配置区域仍可兼容读取", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "claude-legacy-config-test-"));
  try {
    await mkdir(join(projectRoot, "config"));
    await writeFile(
      join(projectRoot, "config", "app.local.json"),
      JSON.stringify({ claude: { sessionKeys: ["legacy"], model: "legacy-model" } }),
      "utf8",
    );
    const config = loadClaudeConfig({ projectRoot, env: { DISPLAY: "1" } });
    assert.deepEqual(config.sessionKeys, ["legacy"]);
    assert.equal(config.model, "legacy-model");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("注册代理优先读取通用环境变量并兼容旧变量", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "proxy-config-test-"));
  try {
    assert.equal(
      resolveProxyUrl({
        projectRoot,
        env: {
          APP_PROXY_URL: "http://app.example.com:8080",
          CLAUDE_PROXY_URL: "http://claude.example.com:8080",
        },
      }),
      "http://app.example.com:8080",
    );
    assert.equal(
      resolveProxyUrl({
        projectRoot,
        env: { CLAUDE_PROXY_URL: "http://claude.example.com:8080" },
      }),
      "http://claude.example.com:8080",
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("随机邮箱后缀支持命令行、环境变量和统一配置优先级", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "email-domain-config-test-"));
  try {
    await mkdir(join(projectRoot, "config"));
    await writeFile(
      join(projectRoot, "config", "app.local.json"),
      JSON.stringify({ mail: { randomDomain: "configured.example.com" } }),
      "utf8",
    );
    assert.equal(
      resolveRandomEmailDomain({ projectRoot, env: {} }),
      "configured.example.com",
    );
    assert.equal(
      resolveRandomEmailDomain({
        projectRoot,
        env: { APP_RANDOM_EMAIL_DOMAIN: "@environment.example.com" },
      }),
      "environment.example.com",
    );
    assert.equal(
      resolveRandomEmailDomain({
        requestedDomain: "@argument.example.com",
        projectRoot,
        env: { APP_RANDOM_EMAIL_DOMAIN: "environment.example.com" },
      }),
      "argument.example.com",
    );
    assert.throws(
      () => resolveRandomEmailDomain({ requestedDomain: "https://invalid.example.com", projectRoot }),
      /不是有效域名/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("注册服务支持命令行、环境变量和统一配置优先级", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "provider-config-test-"));
  try {
    await mkdir(join(projectRoot, "config"));
    await writeFile(
      join(projectRoot, "config", "app.local.json"),
      JSON.stringify({ registration: { provider: "grok" } }),
      "utf8",
    );
    assert.equal(resolveRegistrationProviderId({ projectRoot, env: {} }), "grok");
    assert.equal(
      resolveRegistrationProviderId({
        projectRoot,
        env: { APP_REGISTRATION_PROVIDER: "CLAUDE" },
      }),
      "claude",
    );
    assert.equal(
      resolveRegistrationProviderId({
        requestedProvider: "GROK",
        projectRoot,
        env: { APP_REGISTRATION_PROVIDER: "claude" },
      }),
      "grok",
    );
    assert.throws(
      () => resolveRegistrationProviderId({ requestedProvider: "grok.com", projectRoot }),
      /格式无效/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("CLIProxy xAI OAuth 支持命令行、环境变量和统一配置优先级", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "cliproxy-config-test-"));
  try {
    await mkdir(join(projectRoot, "config"));
    await writeFile(
      join(projectRoot, "config", "app.local.json"),
      JSON.stringify({
        cliproxy: {
          xaiOAuthAfterRegistration: false,
          xaiOAuthUseProxy: false,
          authDir: "configured-auths",
        },
      }),
      "utf8",
    );
    assert.deepEqual(resolveCliProxyXaiOAuth({ projectRoot, env: {} }), {
      enabled: false,
      authDir: "configured-auths",
      useProxy: false,
    });
    assert.deepEqual(resolveCliProxyXaiOAuth({
      projectRoot,
      env: {
        APP_CLIPROXY_XAI_OAUTH: "true",
        APP_CLIPROXY_XAI_OAUTH_PROXY: "true",
        APP_CLIPROXY_AUTH_DIR: "environment-auths",
      },
    }), {
      enabled: true,
      authDir: "environment-auths",
      useProxy: true,
    });
    assert.deepEqual(resolveCliProxyXaiOAuth({
      projectRoot,
      requestedEnabled: false,
      requestedUseProxy: true,
      requestedAuthDir: "argument-auths",
      env: { APP_CLIPROXY_XAI_OAUTH: "true" },
    }), {
      enabled: false,
      authDir: "argument-auths",
      useProxy: true,
    });
    assert.throws(
      () => resolveCliProxyXaiOAuth({
        projectRoot,
        env: { APP_CLIPROXY_XAI_OAUTH: "可能" },
      }),
      /必须是/,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
