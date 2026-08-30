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
import {
  claudePendingLoginCookieRemoval,
  classifyClaudeMagicLinkState,
  extractClaudeVerificationCode,
  sendClaudeMagicLink,
  validateClaudeMagicLink,
} from "../src/providers/claude/login.js";
import { extractGrokVerificationCode } from "../src/providers/grok/mail.js";
import {
  normalizeGrokVerificationCode,
  validateGrokVerificationCode,
} from "../src/providers/grok/login.js";
import { createGrokProfile } from "../src/providers/grok/profile.js";

test("注册服务适配器注册表可以解析 Claude 和 Grok 实现", () => {
  assert.deepEqual(availableRegistrationProviders(), ["claude", "grok"]);
  const provider = getRegistrationProvider("CLAUDE");
  assert.equal(provider.id, "claude");
  assert.equal(typeof provider.completeOnboarding, "function");
  assert.equal(typeof provider.pollVerification, "function");
  assert.equal(getRegistrationProvider("GROK").id, "grok");
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

test("Claude Magic Link 页面能提取新版 6 位验证码并分类", () => {
  const text = [
    "Use verification code to continue",
    "Enter this verification code where you first tried to sign in:",
    "482917",
    "Copy Code",
    "Sign in here instead",
  ].join("\n");
  assert.equal(extractClaudeVerificationCode(text), "482917");
  assert.deepEqual(classifyClaudeMagicLinkState({ text }), { kind: "code", code: "482917" });
  assert.deepEqual(
    classifyClaudeMagicLinkState({ text: "Let's create your account\nWhat is your name?" }),
    { kind: "onboarding" },
  );
  assert.deepEqual(classifyClaudeMagicLinkState({ text: "Loading…" }), { kind: "pending" });
});

test("Claude 发送 Magic Link 会点击 Continue 并读取网络响应", async () => {
  const calls = [];
  let requestPolls = 0;
  const cdp = {
    evaluate(expression) {
      calls.push({ method: "Runtime.evaluate", expression });
      if (expression.includes("const buttons = [...document.querySelectorAll")) {
        return Promise.resolve({ x: 11, y: 22, text: "Continue" });
      }
      if (expression.includes("href: location.href")) {
        return Promise.resolve({
          href: "https://claude.ai/login",
          title: "Sign in - Claude",
          text: "To continue, click the link sent to your email.",
          hasEmailInput: false,
          hasCodeInput: false,
          hasEmailSent: true,
        });
      }
      throw new Error(`unexpected evaluate expression: ${expression.slice(0, 80)}`);
    },
    interestingRequests() {
      requestPolls += 1;
      if (requestPolls === 1) return [];
      return [
        {
          requestId: "request-1",
          request: { url: "https://claude.ai/api/auth/send_magic_link" },
          response: {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          },
        },
      ];
    },
    send(method, params) {
      calls.push({ method, params });
      if (method === "Network.getResponseBody") {
        return Promise.resolve({ body: JSON.stringify({ sent: true }) });
      }
      return Promise.resolve({});
    },
  };

  const result = await sendClaudeMagicLink(cdp, "user@example.com");

  assert.equal(result.status, 200);
  assert.equal(result.statusText, "OK");
  assert.equal(JSON.parse(result.responseText).sent, true);
  assert.deepEqual(
    calls.filter((call) => call.method === "Input.dispatchMouseEvent").map((call) => call.params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.equal(calls.filter((call) => call.method === "Network.getResponseBody").length, 1);
});

test("Claude 会生成删除 pending-login cookie 的指令", () => {
  assert.equal(
    claudePendingLoginCookieRemoval(),
    "__Host-claude-ai-pending-login-email=; Max-Age=0; Path=/; SameSite=Lax; Secure",
  );
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
        verification: attempts > 1 ? "ABC123" : "",
      };
    },
  });
  assert.equal(result.verification, "ABC123");
  assert.equal(attempts, 2);
});

test("Grok 邮件安全码支持真实的三位分组格式", () => {
  const content = "Your one time security code is ABC-123. Use it to finish signing up for Grok.";
  assert.equal(extractGrokVerificationCode(content), "ABC123");
  assert.equal(normalizeGrokVerificationCode("abc-123"), "ABC123");
  assert.doesNotThrow(() => validateGrokVerificationCode("ABC-123"));
  assert.throws(() => validateGrokVerificationCode("12345"), /6 位/);
});

test("Grok 注册资料支持姓名拆分和密码校验", () => {
  assert.deepEqual(createGrokProfile({ name: "Alex Morgan", password: "Passw0rd!" }), {
    givenName: "Alex",
    familyName: "Morgan",
    displayName: "Alex Morgan",
    password: "Passw0rd!",
  });
  assert.throws(() => createGrokProfile({ password: "short" }), /不能少于 8 个字符/);
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
      getVerification: async () => "ABC123",
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
      "校验验证信息",
      "完成验证",
      "完成引导",
      "提取会话",
    ]);
    const saved = JSON.parse(await readFile(outcome.result.outputPath, "utf8"));
    assert.equal(saved.provider, "test");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("通用注册编排器会在读取会话后执行可选授权钩子", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "registration-auth-test-"));
  const calls = [];
  const provider = {
    ...createTestProvider(calls),
    authorizeAfterRegistration: async (_cdp, context) => {
      calls.push("执行授权");
      assert.equal(context.authDir, "auths");
      return {
        oauthAuthorized: true,
        oauthEmail: context.email,
        cliproxyAuthPath: join(projectRoot, "auths", "xai-user@example.com.json"),
      };
    },
  };

  try {
    const outcome = await runRegistration({
      provider,
      projectRoot,
      email: "user@example.com",
      profile: { displayName: "测试用户" },
      authorization: { enabled: true, authDir: "auths" },
      getVerification: async () => "ABC123",
      openRuntime: async () => ({
        cdp: { close() {} },
        bridge: null,
        profileDir: join(projectRoot, "profile"),
        debugPort: 45678,
        async close() {},
      }),
    });
    assert.deepEqual(calls.slice(-2), ["提取会话", "执行授权"]);
    assert.equal(outcome.result.oauthAuthorized, true);
    assert.equal(outcome.result.oauthEmail, "user@example.com");
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
    validateVerification: () => calls.push("校验验证信息"),
    completeVerification: async () => calls.push("完成验证"),
    completeOnboarding: async () => calls.push("完成引导"),
    extractSession: async () => {
      calls.push("提取会话");
      return { sessionKey: "session-test", cookies: [] };
    },
    isManualActionError: () => false,
    summarizeError: (error) => error.message,
  };
}
