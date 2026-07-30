import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  approveXaiDeviceCodeInBrowser,
  authorizeXaiDevice,
  discoverXaiOAuth,
  parseJwtIdentity,
  pollXaiOAuthToken,
  requestXaiDeviceCode,
  validateXaiOAuthEndpoint,
  XAI_DEVICE_GRANT_TYPE,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
} from "../src/providers/grok/oauth.js";
import {
  buildCliProxyXaiAuth,
  cliProxyXaiCredentialFileName,
  writeCliProxyXaiAuth,
} from "../src/integrations/cliproxy/xai-auth.js";

test("xAI OAuth 使用浏览器 SSO Cookie 自动完成设备授权", async () => {
  const sequence = [];
  const progress = [];
  const cdp = {
    async send(method) {
      assert.equal(method, "Network.getCookies");
      sequence.push("读取Cookie");
      return {
        cookies: [{ name: "sso", value: "登录态", domain: ".x.ai" }],
      };
    },
  };
  const token = await authorizeXaiDevice(cdp, {
    wait: async () => {},
    updateProgress: (message) => progress.push(message),
    request: async (url, options = {}) => {
      if (url === "https://accounts.x.ai/") {
        sequence.push("预校验成功");
        assert.match(options.headers.Cookie, /sso=登录态/);
        assert.match(options.headers.Cookie, /sso-rw=登录态/);
        return {
          status: 200,
          headers: {
            "set-cookie": ["csrf_session=临时状态; Domain=.x.ai; Path=/; Secure"],
          },
          body: "账号页",
          url,
        };
      }
      if (url.endsWith("/.well-known/openid-configuration")) {
        sequence.push("服务发现");
        return {
          status: 200,
          body: {
            device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
            token_endpoint: "https://auth.x.ai/oauth2/token",
          },
        };
      }
      if (url.endsWith("/oauth2/device/code")) {
        sequence.push("申请设备码");
        return {
          status: 200,
          body: {
            device_code: "设备码",
            user_code: "ABCD-EFGH",
            verification_uri_complete:
              "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
            expires_in: 1800,
            interval: 5,
          },
        };
      }
      if (url.includes("/oauth2/device?user_code=")) {
        sequence.push("访问验证页");
        return { status: 200, headers: {}, body: "设备验证", url };
      }
      if (url.endsWith("/oauth2/device/verify")) {
        sequence.push("验证设备码");
        assert.equal(options.form.user_code, "ABCD-EFGH");
        assert.match(options.headers.Cookie, /csrf_session=临时状态/);
        return {
          status: 302,
          headers: {
            location: "https://accounts.x.ai/oauth2/device/consent?user_code=ABCD-EFGH",
          },
          body: "",
          url,
        };
      }
      if (url.includes("/oauth2/device/consent?")) {
        sequence.push("读取授权表单");
        return {
          status: 200,
          headers: {},
          body: '<form><input name="csrf_token" value="校验字段"></form>',
          url,
        };
      }
      if (url.endsWith("/oauth2/device/approve")) {
        sequence.push("批准授权");
        assert.equal(options.form.action, "allow");
        assert.equal(options.form.referrer, "grok-build");
        return {
          status: 302,
          headers: { location: "https://accounts.x.ai/oauth2/device/done" },
          body: "",
          url,
        };
      }
      if (url.endsWith("/oauth2/userinfo")) {
        sequence.push("读取用户信息");
        assert.equal(options.headers.Authorization, "Bearer 访问令牌");
        return {
          status: 200,
          headers: {},
          body: { email: "user@example.com", sub: "用户编号" },
          url,
        };
      }
      sequence.push("请求令牌");
      return {
        status: 200,
        body: {
          access_token: "访问令牌",
          refresh_token: "刷新令牌",
          token_type: "Bearer",
          expires_in: 3600,
        },
      };
    },
  });

  assert.deepEqual(sequence, [
    "读取Cookie",
    "预校验成功",
    "服务发现",
    "申请设备码",
    "访问验证页",
    "验证设备码",
    "读取授权表单",
    "批准授权",
    "请求令牌",
    "读取用户信息",
  ]);
  assert.equal(token.access_token, "访问令牌");
  assert.equal(token.email, "user@example.com");
  assert.ok(progress.every((message) => !/预校验未确认/.test(message)));
});

test("xAI OAuth 协议页面受限时自动改用当前浏览器提交固定表单", async () => {
  const sequence = [];
  const cdp = {
    async send(method) {
      assert.equal(method, "Network.getCookies");
      sequence.push("读取Cookie");
      return {
        cookies: [{ name: "sso", value: "登录态", domain: ".x.ai" }],
      };
    },
  };
  const token = await authorizeXaiDevice(cdp, {
    retries: 1,
    wait: async () => {},
    browserApprove: async (_cdp, deviceCode) => {
      sequence.push("浏览器授权");
      assert.equal(deviceCode.user_code, "ABCD-EFGH");
    },
    request: async (url) => {
      if (url === "https://accounts.x.ai/") {
        sequence.push("预校验受限");
        return { status: 403, headers: {}, body: "Cloudflare", url };
      }
      if (url.endsWith("/.well-known/openid-configuration")) {
        sequence.push("服务发现");
        return {
          status: 200,
          body: {
            device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
            token_endpoint: "https://auth.x.ai/oauth2/token",
          },
        };
      }
      if (url.endsWith("/oauth2/device/code")) {
        sequence.push("申请设备码");
        return {
          status: 200,
          body: {
            device_code: "设备码",
            user_code: "ABCD-EFGH",
            verification_uri_complete:
              "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
            expires_in: 1800,
            interval: 5,
          },
        };
      }
      if (url.endsWith("/oauth2/userinfo")) {
        sequence.push("读取用户信息");
        return {
          status: 200,
          body: { email: "user@example.com", sub: "用户编号" },
        };
      }
      sequence.push("请求令牌");
      return {
        status: 200,
        body: {
          access_token: "访问令牌",
          refresh_token: "刷新令牌",
          token_type: "Bearer",
          expires_in: 3600,
        },
      };
    },
  });

  assert.deepEqual(sequence, [
    "读取Cookie",
    "预校验受限",
    "服务发现",
    "申请设备码",
    "浏览器授权",
    "请求令牌",
    "读取用户信息",
  ]);
  assert.equal(token.access_token, "访问令牌");
});

test("xAI OAuth 浏览器回退按 verify 和 approve 表单地址确定性提交", async () => {
  const calls = [];
  const evaluations = [
    {
      href: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
      title: "设备登录",
      verifyForm: true,
      approveForm: false,
      done: false,
      signIn: false,
      blocked: false,
      browserError: false,
      invalidAction: false,
    },
    { submitted: true, action: "https://auth.x.ai/oauth2/device/verify" },
    {
      href: "https://accounts.x.ai/oauth2/device/consent?user_code=ABCD-EFGH",
      title: "授权确认",
      verifyForm: false,
      approveForm: true,
      done: false,
      signIn: false,
      blocked: false,
      browserError: false,
      invalidAction: false,
    },
    { submitted: true, action: "https://auth.x.ai/oauth2/device/approve" },
    {
      href: "https://accounts.x.ai/oauth2/device/done",
      title: "授权完成",
      verifyForm: false,
      approveForm: false,
      done: true,
      signIn: false,
      blocked: false,
      browserError: false,
      invalidAction: false,
    },
  ];
  const cdp = {
    async send(method, params) {
      calls.push({ method, params });
      return {};
    },
    async evaluate(expression) {
      calls.push({ method: "Runtime.evaluate", expression });
      return evaluations.shift();
    },
  };

  await approveXaiDeviceCodeInBrowser(cdp, {
    user_code: "ABCD-EFGH",
    verification_uri_complete:
      "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
  }, {
    wait: async () => {},
  });

  assert.equal(calls[0].method, "Page.navigate");
  assert.match(calls[2].expression, /\/oauth2\/device\/verify/);
  assert.match(calls[4].expression, /\/oauth2\/device\/approve/);
  assert.match(calls[4].expression, /action: "allow"/);
  assert.equal(evaluations.length, 0);
});

test("xAI OAuth 缺少浏览器 SSO Cookie 时立即停止", async () => {
  await assert.rejects(
    authorizeXaiDevice({
      async send() {
        return { cookies: [] };
      },
    }),
    /缺少 sso\/sso-rw 登录 Cookie/,
  );
});

test("xAI OAuth 服务发现只接受 x.ai 的 HTTPS 端点", async () => {
  const discovery = await discoverXaiOAuth({
    request: async () => ({
      status: 200,
      body: {
        device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      },
    }),
  });
  assert.equal(discovery.token_endpoint, "https://auth.x.ai/oauth2/token");
  assert.throws(
    () => validateXaiOAuthEndpoint("http://auth.x.ai/oauth2/token"),
    /必须使用 x.ai 的 HTTPS 地址/,
  );
  assert.throws(
    () => validateXaiOAuthEndpoint("https://x.ai.example.com/oauth2/token"),
    /必须使用 x.ai 的 HTTPS 地址/,
  );
});

test("xAI OAuth 设备码请求与 CLIProxyAPI 参数保持一致", async () => {
  let captured = null;
  const result = await requestXaiDeviceCode({
    discovery: {
      device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
      token_endpoint: "https://auth.x.ai/oauth2/token",
    },
    request: async (url, options) => {
      captured = { url, options };
      return {
        status: 200,
        body: {
          device_code: "设备码",
          user_code: "ABCD-EFGH",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
          expires_in: 1800,
          interval: 5,
        },
      };
    },
    wait: async () => {},
  });
  assert.equal(captured.url, "https://auth.x.ai/oauth2/device/code");
  assert.deepEqual(captured.options.form, {
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPE,
  });
  assert.equal(result.token_endpoint, "https://auth.x.ai/oauth2/token");
});

test("xAI OAuth 令牌轮询支持等待、降速与成功响应", async () => {
  const claims = Buffer.from(JSON.stringify({
    email: "user@example.com",
    sub: "用户编号",
  })).toString("base64url");
  const responses = [
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down" } },
    {
      status: 200,
      body: {
        access_token: "访问令牌",
        refresh_token: "刷新令牌",
        id_token: `头.${claims}.签名`,
        token_type: "Bearer",
        expires_in: 3600,
      },
    },
  ];
  const waits = [];
  const forms = [];
  const pendingAttempts = [];
  const token = await pollXaiOAuthToken({
    device_code: "设备码",
    token_endpoint: "https://auth.x.ai/oauth2/token",
    interval: 1,
    expires_in: 1800,
  }, {
    request: async (_url, options) => {
      forms.push(options.form);
      return responses.shift();
    },
    wait: async (milliseconds) => waits.push(milliseconds),
    onAuthorizationPending: async ({ attempt }) => pendingAttempts.push(attempt),
  });
  assert.deepEqual(waits, [5000, 10000]);
  assert.deepEqual(pendingAttempts, [1]);
  assert.equal(forms[0].grant_type, XAI_DEVICE_GRANT_TYPE);
  assert.equal(forms[0].client_id, XAI_OAUTH_CLIENT_ID);
  assert.equal(token.email, "user@example.com");
  assert.equal(token.sub, "用户编号");
});

test("xAI OAuth 令牌轮询会重试短暂网络错误", async () => {
  let attempts = 0;
  const waits = [];
  const token = await pollXaiOAuthToken({
    device_code: "设备码",
    token_endpoint: "https://auth.x.ai/oauth2/token",
    interval: 5,
    expires_in: 1800,
  }, {
    request: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("测试网络超时");
      return {
        status: 200,
        body: {
          access_token: "访问令牌",
          refresh_token: "刷新令牌",
          token_type: "Bearer",
          expires_in: 3600,
        },
      };
    },
    wait: async (milliseconds) => waits.push(milliseconds),
  });
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [5000]);
  assert.equal(token.access_token, "访问令牌");
});

test("xAI OAuth 服务端拒绝签发令牌时给出账号限制提示", async () => {
  await assert.rejects(
    pollXaiOAuthToken({
      device_code: "设备码",
      token_endpoint: "https://auth.x.ai/oauth2/token",
      interval: 5,
      expires_in: 1800,
    }, {
      request: async () => ({
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "Access denied",
        },
      }),
    }),
    /已完成授权确认.*服务端拒绝.*账号可能受到 Device OAuth 授权限制/,
  );
});

test("JWT 身份解析遇到无效内容时安全返回空值", () => {
  assert.deepEqual(parseJwtIdentity("无效令牌"), { email: "", sub: "" });
});

test("CLIProxy xAI 认证文件字段、名称和权限符合导入格式", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cliproxy-xai-test-"));
  const now = new Date("2026-07-29T12:00:00.000Z");
  const token = {
    access_token: "访问令牌",
    refresh_token: "刷新令牌",
    id_token: "身份令牌",
    token_type: "Bearer",
    expires_in: 3600,
    email: "user+tag@example.com",
    sub: "subject/value",
    token_endpoint: "https://auth.x.ai/oauth2/token",
  };
  try {
    const auth = buildCliProxyXaiAuth(token, { now });
    assert.deepEqual(auth, {
      type: "xai",
      access_token: "访问令牌",
      refresh_token: "刷新令牌",
      id_token: "身份令牌",
      token_type: "Bearer",
      expires_in: 3600,
      expired: "2026-07-29T13:00:00.000Z",
      last_refresh: "2026-07-29T12:00:00.000Z",
      base_url: "https://api.x.ai/v1",
      token_endpoint: "https://auth.x.ai/oauth2/token",
      auth_kind: "oauth",
      disabled: false,
      email: "user+tag@example.com",
      sub: "subject/value",
    });
    assert.equal(
      cliProxyXaiCredentialFileName(token.email, token.sub),
      "xai-user-tag@example.com.json",
    );

    const exported = await writeCliProxyXaiAuth(token, {
      projectRoot: directory,
      authDir: "auths",
      now,
    });
    const saved = JSON.parse(await readFile(exported.outputPath, "utf8"));
    assert.equal(saved.type, "xai");
    assert.equal(saved.auth_kind, "oauth");
    assert.equal(exported.permissionsRestricted, true);
    assert.equal((await stat(exported.outputPath)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
