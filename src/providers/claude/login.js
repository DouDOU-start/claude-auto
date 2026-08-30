import { throwIfAborted, waitWithSignal } from "../../core/abort.js";
import { CdpClient, debugPortFromWebSocketUrl, findPage } from "../../cdp-client.js";

const PENDING_LOGIN_COOKIE = "__Host-claude-ai-pending-login-email";
const MAGIC_LINK_REQUEST = /\/api\/auth\/send_magic_link(?:[?#/]|$)/i;
const CLAUDE_ONBOARDING_TEXT =
  /Let.s create your account|How are you planning|Plans that grow|Before your first chat|What.s your name|Your first chat/i;
const CLAUDE_FALLBACK_CODE_TEXT =
  /Use verification code to continue|Enter this verification code where you first tried to sign in|Sign in here instead/i;

export function claudePendingLoginCookie(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return `__Host-claude-ai-pending-login-email=${encodeURIComponent(normalized)}; Max-Age=3600; Path=/; SameSite=Lax; Secure`;
}

export function claudePendingLoginCookieRemoval() {
  return `${PENDING_LOGIN_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax; Secure`;
}

export async function waitForClaudeLoginReady(cdp, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    lastState = await pageState(cdp).catch(() => null);
    const failureReason = navigationFailureReason(lastState);
    if (failureReason) {
      throw new Error(`Claude 登录页未就绪。${failureReason}。最终状态：${JSON.stringify(lastState)}`);
    }
    if (
      lastState?.href?.includes("claude.ai/login") &&
      lastState?.title === "Sign in - Claude" &&
      lastState?.hasEmailInput
    ) {
      return lastState;
    }
    await waitWithSignal(700, signal);
  }
  throwIfAborted(signal);
  throw new Error(`Claude 登录页未就绪。最终状态：${JSON.stringify(lastState)}`);
}

export async function fillClaudeEmail(cdp, email) {
  const result = await cdp.evaluate(`
    (() => {
      const input = document.querySelector('input#email, input[type="email"], input[data-testid="email"]');
      if (!input) return { ok: false, reason: "未找到邮箱输入框" };
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, ${JSON.stringify(email)});
      else input.value = ${JSON.stringify(email)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: input.value, title: document.title, href: location.href };
    })()
  `);
  if (!result?.ok) throw new Error(result?.reason || "未能填写邮箱输入框。");
  return result;
}

export async function sendClaudeMagicLink(cdp, email, { signal } = {}) {
  const beforeRequestIds = new Set(
    interestingMagicLinkRequests(cdp).map((item) => item.requestId),
  );
  const button = await findClaudeContinueButton(cdp);
  if (!button) throw new Error("未找到 Claude 登录页的 Continue 按钮。");
  await click(cdp, button.x, button.y);
  return waitForClaudeMagicLinkResponse(cdp, {
    email,
    beforeRequestIds,
    signal,
  });
}

export async function openClaudeMagicLink(cdp, url, { signal } = {}) {
  await clearClaudePendingLoginCookie(cdp);
  const target = await openClaudeMagicLinkTarget(cdp, url);
  let closed = false;
  try {
    const outcome = await waitForClaudeMagicLinkOutcome(target.cdp, 90000, signal);
    if (outcome.kind === "code") {
      await closeClaudeMagicLinkTarget(cdp, target);
      closed = true;
      return completeClaudeFallbackCode(cdp, outcome.code, signal);
    }

    const destination = safeClaudeNavigationUrl(outcome.state?.href);
    await closeClaudeMagicLinkTarget(cdp, target);
    closed = true;
    if (destination && !/\/login\/?$/i.test(new URL(destination).pathname)) {
      await cdp.send("Page.navigate", { url: destination });
      await waitWithSignal(2500, signal);
    }
    return waitForText(cdp, CLAUDE_ONBOARDING_TEXT, 90000, signal);
  } finally {
    if (!closed) await closeClaudeMagicLinkTarget(cdp, target);
  }
}

export function validateClaudeMagicLink(url, email) {
  const parsed = new URL(url);
  if (parsed.hostname !== "claude.ai" || !parsed.pathname.includes("/magic-link")) {
    throw new Error("该地址不是 claude.ai 的 Magic Link。");
  }
  const encodedEmail = parsed.hash.split(":")[1] || "";
  if (!encodedEmail) return;
  try {
    const decoded = Buffer.from(encodedEmail, "base64").toString("utf8");
    if (decoded.toLowerCase() !== email.toLowerCase()) {
      throw new Error(`Magic Link 邮箱不匹配：预期 ${email}，实际 ${decoded}`);
    }
  } catch (error) {
    if (error.message.includes("不匹配")) throw error;
  }
}

export function parseClaudeMagicLinkSent(responseText) {
  try {
    return Boolean(JSON.parse(responseText).sent);
  } catch {
    return false;
  }
}

async function dismissCookieBanner(cdp, signal) {
  await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll("button")]
        .find((el) => /reject.*cookies|reject/i.test(el.textContent || ""));
      if (button) button.click();
      return Boolean(button);
    })()
  `).catch(() => false);
  await waitWithSignal(1500, signal);
}

async function findClaudeContinueButton(cdp) {
  return cdp.evaluate(`
    (() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const textOf = (el) => (el.textContent || el.getAttribute("aria-label") || "").trim();
      const buttons = [...document.querySelectorAll("button, [role=button]")]
        .filter((el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
      const button =
        buttons.find((el) => el.getAttribute("data-testid") === "continue") ||
        buttons.find((el) => /^continue$/i.test(textOf(el))) ||
        buttons.find((el) => /^continue with email$/i.test(textOf(el)));
      if (!button) return null;
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: textOf(button) };
    })()
  `);
}

async function waitForClaudeMagicLinkResponse(cdp, { email, beforeRequestIds, signal }) {
  const deadline = Date.now() + 60000;
  let state = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    const request = interestingMagicLinkRequests(cdp).find(
      (item) => !beforeRequestIds.has(item.requestId) && item.response,
    );
    state = await pageState(cdp).catch(() => null);
    if (request) {
      let responseText = await readNetworkResponseBody(cdp, request);
      if (!responseText && Number(request.response?.status) >= 200 && Number(request.response?.status) < 300) {
        responseText = state?.hasEmailSent || state?.hasCodeInput ? '{"sent":true}' : "";
      }
      return {
        email,
        status: request.response?.status || 0,
        statusText: request.response?.statusText || "",
        responseText,
        responseHeaders: request.response?.headers || {},
        requestObserved: true,
        pageReady: Boolean(state?.hasEmailSent || state?.hasCodeInput),
      };
    }
    const failure = claudeSendFailureText(state?.text);
    if (failure) throw new Error(`Claude 邮箱验证邮件发送失败：${failure}`);
    await waitWithSignal(300, signal);
  }
  throwIfAborted(signal);
  throw new Error(`Claude 邮箱验证邮件请求未完成。页面状态：${JSON.stringify(safeClaudePageState(state))}`);
}

function interestingMagicLinkRequests(cdp) {
  if (typeof cdp?.interestingRequests !== "function") return [];
  return cdp.interestingRequests(MAGIC_LINK_REQUEST);
}

async function readNetworkResponseBody(cdp, request) {
  if (!request?.requestId || typeof cdp?.send !== "function") return "";
  try {
    const result = await cdp.send("Network.getResponseBody", { requestId: request.requestId });
    return String(result?.body || "");
  } catch {
    return "";
  }
}

async function clearClaudePendingLoginCookie(cdp) {
  await cdp.evaluate(`
    (() => {
      document.cookie = ${JSON.stringify(claudePendingLoginCookieRemoval())};
      return true;
    })()
  `).catch(() => false);
}

async function openClaudeMagicLinkTarget(cdp, url) {
  const debugPort = debugPortFromWebSocketUrl(cdp?.wsUrl);
  if (!debugPort) throw new Error("无法从 Claude CDP 连接解析浏览器调试端口。");
  let targetId = "";
  try {
    const created = await cdp.send("Target.createTarget", { url, background: true });
    targetId = created?.targetId || "";
    if (!targetId) throw new Error("浏览器未返回 Magic Link 页面目标。");
    const page = await findPage(debugPort, { targetId, timeoutMs: 15000 });
    const child = new CdpClient(page.webSocketDebuggerUrl);
    await child.connect();
    await child.send("Page.enable");
    return { targetId, cdp: child };
  } catch (error) {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    throw new Error(`无法打开 Claude Magic Link 页面：${error.message}`);
  }
}

async function closeClaudeMagicLinkTarget(ownerCdp, target) {
  if (!target) return;
  await ownerCdp.send("Target.closeTarget", { targetId: target.targetId }).catch(() => {});
  target.cdp?.close();
}

async function waitForClaudeMagicLinkOutcome(cdp, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await pageState(cdp).catch(() => null);
    const outcome = classifyClaudeMagicLinkState(state);
    if (outcome.kind !== "pending") return { ...outcome, state };
    const failure = navigationFailureReason(state);
    if (failure) throw new Error(`Claude Magic Link 页面加载失败：${failure}`);
    if (/expired|already used|could not verify|unable to verify/i.test(state?.text || "")) {
      throw new Error(`Claude Magic Link 已失效。页面状态：${JSON.stringify(safeClaudePageState(state))}`);
    }
    await waitWithSignal(700, signal);
  }
  throwIfAborted(signal);
  throw new Error(`Claude Magic Link 页面未完成。最终状态：${JSON.stringify(safeClaudePageState(state))}`);
}

export function classifyClaudeMagicLinkState(state) {
  const text = String(state?.text || "");
  CLAUDE_ONBOARDING_TEXT.lastIndex = 0;
  if (CLAUDE_ONBOARDING_TEXT.test(text)) return { kind: "onboarding" };
  CLAUDE_FALLBACK_CODE_TEXT.lastIndex = 0;
  const code = extractClaudeVerificationCode(text);
  if (code && CLAUDE_FALLBACK_CODE_TEXT.test(text)) return { kind: "code", code };
  return { kind: "pending" };
}

export function extractClaudeVerificationCode(text) {
  const raw = String(text || "");
  const context = raw.match(
    /(?:Use verification code to continue|Enter this verification code where you first tried to sign in)[\s\S]{0,240}/i,
  )?.[0] || "";
  const nearby = context.match(/(?<!\d)\d{6}(?!\d)/);
  if (nearby) return nearby[0];
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const index = lines.findIndex((line) => /verification code|sign in here instead/i.test(line));
  if (index >= 0) {
    const code = lines.slice(index, index + 8).join(" ").match(/(?<!\d)\d{6}(?!\d)/);
    if (code) return code[0];
  }
  return "";
}

async function completeClaudeFallbackCode(cdp, code, signal) {
  await showClaudeCodeInput(cdp, signal);
  const result = await cdp.evaluate(`
    (() => {
      const input = document.querySelector('#code, input[data-testid="code"], input[autocomplete="one-time-code"]');
      if (!input) return { ok: false, reason: "未找到 Claude 邮箱验证码输入框" };
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, ${JSON.stringify(code)});
      else input.value = ${JSON.stringify(code)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: input.value };
    })()
  `);
  if (!result?.ok) throw new Error(result?.reason || "未找到 Claude 邮箱验证码输入框。");
  const button = await findClaudeCodeContinueButton(cdp);
  if (!button) throw new Error("未找到 Claude 邮箱验证码确认按钮。");
  await click(cdp, button.x, button.y);
  return waitForText(cdp, CLAUDE_ONBOARDING_TEXT, 90000, signal);
}

async function showClaudeCodeInput(cdp, signal) {
  let state = await pageState(cdp).catch(() => null);
  if (state?.hasCodeInput) return state;
  const button = await cdp.evaluate(`
    (() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const button = [...document.querySelectorAll('button, [role="button"]')]
        .find((el) => visible(el) && !el.disabled &&
          (el.getAttribute("data-testid") === "enter-code" || /enter verification code/i.test(el.textContent || "")));
      if (!button) return null;
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
  if (!button) {
    throw new Error(`Claude 原始登录页未找到“Enter verification code”入口。页面状态：${JSON.stringify(safeClaudePageState(state))}`);
  }
  await click(cdp, button.x, button.y);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await pageState(cdp).catch(() => null);
    if (state?.hasCodeInput) return state;
    await waitWithSignal(300, signal);
  }
  throw new Error(`Claude 原始登录页未进入验证码输入状态。页面状态：${JSON.stringify(safeClaudePageState(state))}`);
}

async function findClaudeCodeContinueButton(cdp) {
  return cdp.evaluate(`
    (() => {
      const visible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter((el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
      const button = buttons.find((el) => el.getAttribute("data-testid") === "continue") ||
        buttons.find((el) => /verify email address/i.test(el.textContent || ""));
      if (!button) return null;
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
}

function safeClaudeNavigationUrl(href) {
  try {
    const parsed = new URL(String(href || ""));
    if (parsed.origin !== "https://claude.ai") return "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function safeClaudePageState(state) {
  if (!state) return null;
  return {
    ...state,
    href: safeClaudeNavigationUrl(state.href) || String(state.href || "").split("#", 1)[0],
    text: redactClaudeSensitiveText(state.text),
  };
}

function redactClaudeSensitiveText(text) {
  return String(text || "").replace(/(?<!\d)\d{6}(?!\d)/g, "[redacted-code]").slice(0, 1500);
}

function claudeSendFailureText(text) {
  const match = String(text || "").match(
    /There was an error sending you a login link|Too many login attempts|Unable to send|rate limit/i,
  );
  return match?.[0] || "";
}

async function waitForText(cdp, regex, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await pageState(cdp).catch(() => null);
    regex.lastIndex = 0;
    if (state?.text && regex.test(state.text)) return state;
    await waitWithSignal(1000, signal);
  }
  throwIfAborted(signal);
  throw new Error(`未找到预期页面文字。最终状态：${JSON.stringify(safeClaudePageState(state))}`);
}

async function pageState(cdp) {
  return cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 7000) || "",
    hasEmailInput: Boolean(document.querySelector('input#email, input[type="email"], input[data-testid="email"]'))
    ,hasCodeInput: Boolean(document.querySelector('#code, input[data-testid="code"], input[autocomplete="one-time-code"]'))
    ,hasEmailSent: /To continue, click the link sent to|Enter verification code/i.test(document.body?.innerText || "")
  })`);
}

function navigationFailureReason(state) {
  if (!state) return "";
  const text = [state.href, state.title, state.text].filter(Boolean).join("\n");
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(text)) return "ERR_TUNNEL_CONNECTION_FAILED";
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_PROXY_AUTH_UNSUPPORTED/i.test(text)) {
    return "代理连接失败";
  }
  if (/This site can.t be reached|This page isn.t working/i.test(text) && /ERR_/i.test(text)) {
    const match = text.match(/ERR_[A-Z0-9_]+/i);
    return match?.[0] || "浏览器导航失败";
  }
  return "";
}

async function click(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}
