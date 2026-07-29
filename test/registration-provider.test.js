import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CdpClient } from "../src/cdp-client.js";
import { runRegistration } from "../src/core/registration-runner.js";
import { pollVerificationMessage } from "../src/mail/poller.js";
import { parseMailAccountLine } from "../src/mail/account.js";
import { availableRegistrationProviders, getRegistrationProvider } from "../src/providers/index.js";
import { extractClaudeMagicLink } from "../src/providers/claude/mail.js";
import { validateClaudeMagicLink } from "../src/providers/claude/login.js";

test("注册服务适配器注册表可以解析 Claude 实现", () => {
  assert.deepEqual(availableRegistrationProviders(), ["claude"]);
  const provider = getRegistrationProvider("CLAUDE");
  assert.equal(provider.id, "claude");
  assert.equal(typeof provider.completeOnboarding, "function");
  assert.equal(typeof provider.pollVerification, "function");
});

test("Claude Magic Link 提取会校验目标邮箱", () => {
  const email = "user@example.com";
  const encodedEmail = Buffer.from(email).toString("base64");
  const link = `https://claude.ai/magic-link#token:${encodedEmail}`;
  const content = `请打开：${link.replace(/=/g, "=3D")}`;
  assert.equal(extractClaudeMagicLink(content, email), link);
  assert.equal(extractClaudeMagicLink(content, "other@example.com"), "");
  assert.doesNotThrow(() => validateClaudeMagicLink(link, email));
  assert.throws(() => validateClaudeMagicLink(link, "other@example.com"), /邮箱不匹配/);
});

test("通用邮件轮询器不依赖具体站点", async () => {
  let attempts = 0;
  const result = await pollVerificationMessage({
    providerName: "测试服务",
    intervalMs: 1,
    timeoutMs: 100,
    tryRead: async () => {
      attempts += 1;
      return {
        mode: "测试邮箱",
        verificationUrl: attempts > 1 ? "https://example.com/verify" : "",
      };
    },
  });
  assert.equal(result.verificationUrl, "https://example.com/verify");
  assert.equal(attempts, 2);
});

test("邮箱账号解析逻辑已与 Claude 邮件匹配解耦", () => {
  assert.deepEqual(parseMailAccountLine("a@b.com----密码----客户端----刷新令牌"), {
    email: "a@b.com",
    password: "密码",
    clientId: "客户端",
    refreshToken: "刷新令牌",
  });
});

test("CDP 请求筛选器支持服务适配器自定义规则", () => {
  const cdp = new CdpClient("ws://example.invalid");
  cdp.requests.set("1", { request: { url: "https://example.com/register" } });
  cdp.requests.set("2", { request: { url: "https://example.com/chat" } });
  assert.equal(cdp.interestingRequests(/register/).length, 1);
});

test("关闭 CDP 时会拒绝仍在等待的请求", async () => {
  const cdp = new CdpClient("ws://example.invalid");
  cdp.ws = { send() {}, close() {} };
  const pending = cdp.send("Runtime.evaluate");
  cdp.close(new Error("测试取消"));
  await assert.rejects(pending, /测试取消/);
});

test("通用注册编排器按服务适配器接口执行并关闭资源", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "registration-runner-test-"));
  const calls = [];
  let runtimeClosed = false;
  const cdp = { close() { calls.push("关闭CDP"); } };
  const provider = createTestProvider(calls);

  try {
    const outcome = await runRegistration({
      provider,
      projectRoot,
      email: "user@example.com",
      profile: { displayName: "测试用户" },
      getVerificationUrl: async () => "https://example.com/verify",
      openRuntime: async () => ({
        cdp,
        bridge: null,
        profileDir: join(projectRoot, "profile"),
        debugPort: 45678,
        async close() {
          runtimeClosed = true;
          cdp.close();
        },
      }),
    });

    assert.equal(outcome.status, "completed");
    assert.equal(outcome.result.sessionKey, "session-test");
    assert.equal(runtimeClosed, true);
    assert.deepEqual(calls.slice(0, 7), [
      "等待登录页",
      "填写邮箱",
      "发送验证",
      "校验链接",
      "打开链接",
      "完成引导",
      "提取会话",
    ]);
    const saved = JSON.parse(await readFile(outcome.result.outputPath, "utf8"));
    assert.equal(saved.provider, "test");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

function createTestProvider(calls) {
  return {
    id: "test",
    displayName: "测试服务",
    startUrl: "https://example.com/register",
    pageUrlIncludes: "example.com",
    profilePrefix: "test-register",
    resultFilePrefix: "test-register",
    resultProfile: (profile) => ({ name: profile.displayName }),
    waitForLoginReady: async () => calls.push("等待登录页"),
    submitEmail: async () => calls.push("填写邮箱"),
    sendVerification: async () => {
      calls.push("发送验证");
      return { status: 200, responseText: "{}" };
    },
    verificationWasSent: () => true,
    validateVerificationUrl: () => calls.push("校验链接"),
    openVerification: async () => calls.push("打开链接"),
    completeOnboarding: async () => calls.push("完成引导"),
    extractSession: async () => {
      calls.push("提取会话");
      return { sessionKey: "session-test", cookies: [] };
    },
    isManualActionError: () => false,
    summarizeError: (error) => error.message,
  };
}
