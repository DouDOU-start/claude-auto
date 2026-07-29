import { throwIfAborted, waitWithSignal } from "../../core/abort.js";

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

export async function sendClaudeMagicLink(cdp, email) {
  return cdp.evaluate(`
    (async () => {
      const body = {
        utc_offset: new Date().getTimezoneOffset() * -1,
        email_address: ${JSON.stringify(email)},
        login_intent: null,
        locale: document.documentElement.lang || navigator.language || "en-US",
        return_to: null,
        source: "claude"
      };
      const response = await fetch("/api/auth/send_magic_link", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "anthropic-client-platform": "web_claude_ai",
          "anthropic-client-version": document.documentElement.dataset.version || "1.0.0",
          "anthropic-client-sha": document.documentElement.dataset.gitHash || document.documentElement.dataset.buildId || "",
          "anthropic-device-id": document.cookie.match(/(?:^|; )anthropic-device-id=([^;]+)/)?.[1] || "",
          "anthropic-anonymous-id": document.cookie.match(/(?:^|; )ajs_anonymous_id=([^;]+)/)?.[1] || ""
        },
        body: JSON.stringify(body)
      });
      return {
        requestBody: body,
        status: response.status,
        statusText: response.statusText,
        responseText: await response.text(),
        responseHeaders: Object.fromEntries(response.headers.entries())
      };
    })()
  `);
}

export async function openClaudeMagicLink(cdp, url, signal) {
  await cdp.send("Page.navigate", { url });
  await waitWithSignal(10000, signal);
  await dismissCookieBanner(cdp, signal);
  return waitForText(
    cdp,
    /Let.s create your account|How are you planning|Plans that grow|Before your first chat|What.s your name|Your first chat/i,
    90000,
    signal,
  );
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
  throw new Error(`未找到预期页面文字。最终状态：${JSON.stringify(state)}`);
}

async function pageState(cdp) {
  return cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 7000) || "",
    hasEmailInput: Boolean(document.querySelector('input#email, input[type="email"], input[data-testid="email"]'))
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
