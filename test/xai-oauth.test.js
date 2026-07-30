import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
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
