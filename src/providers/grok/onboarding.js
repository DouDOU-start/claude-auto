import { throwIfAborted, waitWithSignal } from "../../core/abort.js";
import { dispatchGrokClick, fillGrokInput } from "./browser-actions.js";

export async function completeGrokAccountCreation(cdp, {
  givenName,
  familyName,
  password,
  signal,
  updateProgress = () => {},
}) {
  await fillGrokInput(cdp, 'input[data-testid="givenName"]', givenName, {
    missingMessage: '未找到 Grok 注册输入框：input[data-testid="givenName"]',
  });
  await fillGrokInput(cdp, 'input[data-testid="familyName"]', familyName, {
    missingMessage: '未找到 Grok 注册输入框：input[data-testid="familyName"]',
  });
  await fillGrokInput(cdp, 'input[data-testid="password"]', password, {
    missingMessage: '未找到 Grok 注册输入框：input[data-testid="password"]',
  });
  const beforeSubmit = await waitForSubmitReady(cdp, signal);
  await clickCompleteSignUp(cdp);
  if (!beforeSubmit.turnstileReady) {
    updateProgress("正在等待 Grok Turnstile 验证……");
    const turnstileState = await waitForTurnstile(cdp, signal);
    if (!turnstileState.navigated) {
      await waitWithSignal(800, signal);
      const readyState = await waitForSubmitReady(cdp, signal, {
        requireTurnstile: true,
      });
      if (readyState.navigated) return readyState;
      updateProgress("Turnstile 验证已完成，正在提交注册资料……");
      await clickCompleteSignUp(cdp);
    }
  }

  const deadline = Date.now() + 120000;
  let state = null;
  let turnstileSeen = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await onboardingState(cdp).catch(() => null);
    if (state?.href?.startsWith("https://grok.com/") && state?.hasChatInput) return state;
    if (state?.turnstileVisible) turnstileSeen = true;
    const formError = detectFormError(state?.text || "");
    if (formError) throw new Error(`Grok 账号创建失败：${formError}`);
    await waitWithSignal(1000, signal);
  }

  throwIfAborted(signal);
  if (turnstileSeen) {
    throw new Error(`需要人工完成 Grok Turnstile 安全验证。页面状态：${JSON.stringify(state)}`);
  }
  throw new Error(`Grok 注册后未能进入首页。页面状态：${JSON.stringify(state)}`);
}

export async function clickCompleteSignUp(cdp) {
  const target = await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll("button")]
        .find((item) =>
          /Complete sign up/i.test(item.textContent || "") &&
          item.offsetParent !== null &&
          !item.disabled
        );
      if (!button) return { ok: false, reason: "未找到完成注册按钮" };
      const form = button.closest("form");
      if (!form) return { ok: false, reason: "完成注册按钮不在表单中" };
      if (!form.checkValidity()) {
        return { ok: false, reason: "注册资料未通过浏览器表单校验" };
      }
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        return { ok: false, reason: "完成注册按钮当前不可见" };
      }
      return {
        ok: true,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2
      };
    })()
  `);
  if (!target?.ok) {
    throw new Error(`未能提交 Grok 注册资料：${target?.reason || "未知原因"}`);
  }
  await dispatchGrokClick(cdp, target);
}

export const completeGrokOnboarding = completeGrokAccountCreation;

async function waitForSubmitReady(cdp, signal, {
  requireTurnstile = false,
} = {}) {
  const deadline = Date.now() + 15000;
  let state = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await submissionState(cdp).catch(() => null);
    if (state?.navigated) return state;
    if (
      state?.buttonVisible &&
      !state.buttonDisabled &&
      state.formValid &&
      (!requireTurnstile || state.turnstileReady)
    ) {
      return state;
    }
    const formError = detectFormError(state?.text || "");
    if (formError) throw new Error(`Grok 账号创建失败：${formError}`);
    await waitWithSignal(300, signal);
  }

  throwIfAborted(signal);
  const reason = requireTurnstile
    ? "Grok Turnstile 验证完成后，注册按钮未进入可提交状态"
    : "Grok 注册按钮未进入可提交状态";
  throw new Error(`${reason}。页面状态：${JSON.stringify(state)}`);
}

async function waitForTurnstile(cdp, signal) {
  const deadline = Date.now() + 90000;
  let state = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await submissionState(cdp).catch(() => null);
    if (state?.navigated) return state;
    if (state?.turnstileReady) return state;
    const formError = detectFormError(state?.text || "");
    if (formError) throw new Error(`Grok 账号创建失败：${formError}`);
    await waitWithSignal(700, signal);
  }

  throwIfAborted(signal);
  throw new Error(`Grok Turnstile 令牌等待超时。页面状态：${JSON.stringify(state)}`);
}

async function submissionState(cdp) {
  return cdp.evaluate(`
    (() => {
      const token = document.querySelector('input[name="cf-turnstile-response"]');
      const button = [...document.querySelectorAll("button")]
        .find((item) => /Complete sign up/i.test(item.textContent || ""));
      const form = button?.closest("form") || null;
      return {
        href: location.href,
        text: document.body?.innerText?.slice(0, 3000) || "",
        navigated: location.href.startsWith("https://grok.com/"),
        turnstileReady: Boolean(token?.value),
        turnstileTokenLength: token?.value?.length || 0,
        buttonVisible: Boolean(button && button.offsetParent !== null),
        buttonDisabled: Boolean(button?.disabled),
        formValid: Boolean(form?.checkValidity())
      };
    })()
  `);
}

async function onboardingState(cdp) {
  return cdp.evaluate(`
    (() => {
      const text = document.body?.innerText?.slice(0, 5000) || "";
      const challengeFrames = [...document.querySelectorAll("iframe")].filter((frame) =>
        /cloudflare|turnstile|challenge/i.test([frame.src, frame.title].join(" "))
      );
      const turnstileVisible = challengeFrames.some((frame) => {
        const rect = frame.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return {
        href: location.href,
        title: document.title,
        text,
        hasChatInput: Boolean(document.querySelector("textarea")),
        turnstileVisible
      };
    })()
  `);
}

function detectFormError(text) {
  const match = String(text).match(
    /password (?:must|should|is invalid)|invalid password|email.{0,40}already|unable to create|try again|rate limit|too many requests/i,
  );
  return match?.[0] || "";
}
