import {
  fillClaudeEmail,
  openClaudeMagicLink,
  parseClaudeMagicLinkSent,
  sendClaudeMagicLink,
  validateClaudeMagicLink,
  waitForClaudeLoginReady,
} from "./login.js";
import { completeClaudeOnboarding } from "./onboarding.js";
import { extractClaudeSession } from "./session.js";
import { pollClaudeMagicLink } from "./mail.js";
import { createClaudeProfile } from "./profile.js";

export const claudeRegistrationProvider = Object.freeze({
  id: "claude",
  displayName: "Claude",
  startUrl: "https://claude.ai/login",
  pageUrlIncludes: "claude.ai",
  profilePrefix: "claude-register",
  resultFilePrefix: "claude-register",
  verificationLabel: "邮箱验证链接",
  verificationPrompt: "Magic Link 地址：",
  interestingRequestMatcher: /send_magic_link|login_methods|auth/i,

  createProfile(options) {
    return createClaudeProfile(options);
  },

  resultProfile(profile) {
    return { name: profile.displayName, birthday: profile.birthday };
  },

  waitForLoginReady(cdp, { timeoutMs, signal }) {
    return waitForClaudeLoginReady(cdp, timeoutMs, signal);
  },

  submitEmail(cdp, email) {
    return fillClaudeEmail(cdp, email);
  },

  sendVerification(cdp, email) {
    return sendClaudeMagicLink(cdp, email);
  },

  verificationWasSent(result) {
    return parseClaudeMagicLinkSent(result.responseText);
  },

  validateVerification(url, email) {
    validateClaudeMagicLink(url, email);
  },

  completeVerification(cdp, url, { signal }) {
    return openClaudeMagicLink(cdp, url, signal);
  },

  completeOnboarding(cdp, { profile, signal }) {
    return completeClaudeOnboarding(cdp, { ...profile, signal });
  },

  extractSession(cdp) {
    return extractClaudeSession(cdp);
  },

  async pollVerification({ account, since, timeoutMs, intervalMs, log, signal }) {
    const result = await pollClaudeMagicLink({
      account,
      since,
      timeoutMs,
      intervalMs,
      log,
      signal,
    });
    return { ...result, verification: result.magicLink, verificationUrl: result.magicLink };
  },

  isManualActionError(error) {
    return /需要手机验证/i.test(error?.message || "");
  },

  isRetryableError(error) {
    return /Claude 登录页未就绪|ERR_TUNNEL_CONNECTION_FAILED|DevTools 端口未能按时启动|隧道|代理/i.test(
      error?.message || "",
    );
  },

  summarizeError(error) {
    const value = String(error?.message || error || "");
    if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(value)) return "检测到代理隧道失败。";
    if (/Claude 登录页未就绪/i.test(value)) {
      return "Claude 登录页未就绪，可能是代理或 Cloudflare 加载失败。";
    }
    if (/需要手机验证/i.test(value)) return "需要手机验证。";
    return value.split(/\r?\n/).filter(Boolean).slice(-3).join(" ").slice(0, 800);
  },
});
