import {
  completeGrokEmailVerification,
  fillGrokEmail,
  parseGrokVerificationSent,
  sendGrokVerificationCode,
  validateGrokVerificationCode,
  waitForGrokLoginReady,
} from "./login.js";
import { pollGrokVerificationCode } from "./mail.js";
import { completeGrokOnboarding } from "./onboarding.js";
import { createGrokProfile } from "./profile.js";
import { extractGrokSession } from "./session.js";
import { authorizeXaiDevice } from "./oauth.js";
import { writeCliProxyXaiAuth } from "../../integrations/cliproxy/xai-auth.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const grokRegistrationProvider = Object.freeze({
  id: "grok",
  displayName: "Grok",
  startUrl: "https://grok.com/",
  pageUrlIncludes: "grok.com",
  profilePrefix: "grok-register",
  resultFilePrefix: "grok-register",
  verificationLabel: "邮箱安全码",
  verificationPrompt: "邮箱安全码：",
  interestingRequestMatcher: /auth_mgmt|EmailValidation|ValidatePassword|sign-up|turnstile/i,

  createProfile(options) {
    return createGrokProfile(options);
  },

  resultProfile(profile) {
    return {
      name: profile.displayName,
      givenName: profile.givenName,
      familyName: profile.familyName,
      password: profile.password,
    };
  },

  waitForLoginReady(cdp, { timeoutMs, signal }) {
    return waitForGrokLoginReady(cdp, timeoutMs, signal);
  },

  submitEmail(cdp, email) {
    return fillGrokEmail(cdp, email);
  },

  sendVerification(cdp, email, { signal }) {
    return sendGrokVerificationCode(cdp, email, signal);
  },

  verificationWasSent(result) {
    return parseGrokVerificationSent(result);
  },

  validateVerification(value) {
    validateGrokVerificationCode(value);
  },

  completeVerification(cdp, value, { signal }) {
    return completeGrokEmailVerification(cdp, value, signal);
  },

  completeOnboarding(cdp, { profile, signal, updateProgress }) {
    return completeGrokOnboarding(cdp, { ...profile, signal, updateProgress });
  },

  extractSession(cdp) {
    return extractGrokSession(cdp);
  },

  async authorizeAfterRegistration(cdp, {
    email,
    projectRoot,
    authDir,
    proxyUrl,
    signal,
    updateProgress,
  }) {
    const traceEnabled = /^(?:1|true|yes|on)$/i.test(
      String(process.env.APP_GROK_OAUTH_TRACE || "").trim(),
    );
    const trace = [];
    let token;
    try {
      token = await authorizeXaiDevice(cdp, {
        proxyUrl,
        signal,
        updateProgress,
        trace: traceEnabled ? (event) => trace.push(event) : undefined,
      });
    } finally {
      if (traceEnabled) {
        const directory = join(projectRoot, "logs");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const stamp = new Date().toISOString()
          .replace(/[-:]/g, "")
          .replace(/\..+/, "")
          .replace("T", "-");
        const outputPath = join(directory, `grok-oauth-trace-${stamp}.json`);
        await writeFile(outputPath, `${JSON.stringify({ email, trace }, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        updateProgress(`xAI OAuth 脱敏抓包已保存：${outputPath}`);
      }
    }
    const exported = await writeCliProxyXaiAuth(token, {
      projectRoot,
      authDir,
    });
    return {
      oauthAuthorized: true,
      oauthEmail: exported.email || email,
      oauthSubject: exported.subject,
      oauthExpired: exported.expired,
      cliproxyAuthPath: exported.outputPath,
      cliproxyAuthPermissionsRestricted: exported.permissionsRestricted,
    };
  },

  pollVerification({ account, since, timeoutMs, intervalMs, log, signal }) {
    return pollGrokVerificationCode({
      account,
      since,
      timeoutMs,
      intervalMs,
      log,
      signal,
    });
  },

  isManualActionError(error) {
    return /Turnstile|安全验证|人工完成/i.test(error?.message || "");
  },

  isRetryableError(error) {
    return /Grok 注册页未就绪|407 Proxy Authentication Required|代理服务器拒绝|ERR_TUNNEL_CONNECTION_FAILED|DevTools 端口未能按时启动|代理|连接失败|rate limit|too many requests/i.test(
      error?.message || "",
    );
  },

  summarizeError(error) {
    const value = String(error?.message || error || "");
    if (/407 Proxy Authentication Required|代理服务器拒绝/i.test(value)) {
      return "当前代理不允许访问 Grok，请更换代理或使用 --no-proxy。";
    }
    if (/Turnstile|安全验证/i.test(value)) return "需要人工完成 Grok Turnstile 安全验证。";
    if (/Grok 注册页未就绪/i.test(value)) return "Grok 注册页未就绪，可能是代理或网络加载失败。";
    return value.split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 800);
  },
});
