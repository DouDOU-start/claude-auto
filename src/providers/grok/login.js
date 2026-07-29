import { throwIfAborted, waitWithSignal } from "../../core/abort.js";

export async function waitForGrokLoginReady(cdp, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  let state = null;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await grokPageState(cdp).catch(() => null);
    const failureReason = navigationFailureReason(state);
    if (failureReason) {
      throw new Error(`Grok 注册页未就绪。${failureReason}。最终状态：${JSON.stringify(state)}`);
    }
    if (state?.hasEmailInput) return state;

    if (state?.hasSignUpWithEmail) {
      await clickByText(cdp, /Sign up with email/i);
      await waitWithSignal(1000, signal);
      continue;
    }

    if (state?.href?.includes("grok.com") && state?.hasSignUp) {
      await clickByText(cdp, /Sign up|Create account/i);
      await waitWithSignal(1200, signal);
      continue;
    }

    await waitWithSignal(700, signal);
  }

  throwIfAborted(signal);
  throw new Error(`Grok 注册页未就绪。最终状态：${JSON.stringify(state)}`);
}

export async function fillGrokEmail(cdp, email) {
  await fillInputBySelector(cdp, 'input[type="email"], input[name="email"]', email);
  const value = await cdp.evaluate(
    `document.querySelector('input[type="email"], input[name="email"]')?.value || ""`,
  );
  if (String(value).toLowerCase() !== String(email).toLowerCase()) {
    throw new Error("未能正确填写 Grok 注册邮箱。");
  }
  return { ok: true, value };
}

export async function sendGrokVerificationCode(cdp, email, signal) {
  const beforeCount = cdp.interestingRequests(/CreateEmailValidationCode/i).length;
  await clickByText(cdp, /Continue|Sign up/i);

  const deadline = Date.now() + 60000;
  let state = null;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await grokPageState(cdp).catch(() => null);
    if (state?.hasCodeInput) {
      const requests = cdp.interestingRequests(/CreateEmailValidationCode/i);
      const request = requests.at(-1);
      return {
        email,
        status: request?.response?.status || 200,
        statusText: request?.response?.statusText || "",
        responseText: "",
        pageReady: true,
        requestObserved: requests.length > beforeCount,
      };
    }
    const errorText = formErrorText(state?.text || "");
    if (errorText) throw new Error(`Grok 验证码发送失败：${errorText}`);
    await waitWithSignal(700, signal);
  }

  throwIfAborted(signal);
  throw new Error(`Grok 邮箱验证码页面未出现。最终状态：${JSON.stringify(state)}`);
}

export function parseGrokVerificationSent(result) {
  return Boolean(result?.pageReady && Number(result?.status) >= 200 && Number(result?.status) < 300);
}

export function normalizeGrokVerificationCode(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function validateGrokVerificationCode(value) {
  const code = normalizeGrokVerificationCode(value);
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    throw new Error("Grok 邮箱安全码必须是 6 位字母或数字。");
  }
  return code;
}

export async function completeGrokEmailVerification(cdp, value, signal) {
  const code = validateGrokVerificationCode(value);
  const documentNode = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const inputNode = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector: "input[name=code]",
  });
  if (!inputNode.nodeId) throw new Error("未找到 Grok 邮箱安全码输入框。");

  await cdp.send("DOM.focus", { nodeId: inputNode.nodeId });
  await clearFocusedInput(cdp);
  for (const character of code) {
    await cdp.send("Input.dispatchKeyEvent", {
      type: "char",
      text: character,
      unmodifiedText: character,
      key: character,
    });
  }
  await waitWithSignal(800, signal);

  const deadline = Date.now() + 60000;
  let state = null;
  let confirmClicked = false;
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    state = await grokPageState(cdp).catch(() => null);
    if (state?.hasCredentialInputs) return state;
    const errorText = formErrorText(state?.text || "");
    if (errorText) throw new Error(`Grok 邮箱安全码校验失败：${errorText}`);
    if (state?.hasCodeInput && !confirmClicked) {
      confirmClicked = await clickByText(cdp, /Confirm email/i).then(() => true).catch(() => false);
    }
    await waitWithSignal(700, signal);
  }

  throwIfAborted(signal);
  throw new Error(`Grok 注册资料页面未出现。最终状态：${JSON.stringify(state)}`);
}

async function fillInputBySelector(cdp, selector, value) {
  const documentNode = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const inputNode = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!inputNode.nodeId) throw new Error(`未找到输入框：${selector}`);
  await cdp.send("DOM.focus", { nodeId: inputNode.nodeId });
  await clearFocusedInput(cdp);
  await cdp.send("Input.insertText", { text: String(value) });
}

async function clearFocusedInput(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    modifiers: 2,
  });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Backspace", code: "Backspace" });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace" });
}

async function clickByText(cdp, pattern) {
  const point = await cdp.evaluate(`
    (() => {
      const pattern = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      const candidates = [...document.querySelectorAll("button, a, [role=button]")];
      const element = candidates.find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && pattern.test(item.textContent || "") &&
          !item.disabled && item.getAttribute("aria-disabled") !== "true";
      });
      if (!element) return null;
      element.scrollIntoView({ block: "center", inline: "center" });
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()
  `);
  if (!point) throw new Error(`未找到页面操作入口：${pattern}`);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function grokPageState(cdp) {
  return cdp.evaluate(`
    (() => {
      const text = document.body?.innerText?.slice(0, 7000) || "";
      return {
        href: location.href,
        title: document.title,
        text,
        hasEmailInput: Boolean(document.querySelector('input[type="email"], input[name="email"]')),
        hasCodeInput: Boolean(document.querySelector('input[name="code"]')),
        hasCredentialInputs: Boolean(
          document.querySelector('input[data-testid="givenName"]') &&
          document.querySelector('input[data-testid="familyName"]') &&
          document.querySelector('input[data-testid="password"]')
        ),
        hasSignUpWithEmail: /Sign up with email/i.test(text),
        hasSignUp: /Sign up|Create account/i.test(text)
      };
    })()
  `);
}

function formErrorText(text) {
  const match = String(text).match(
    /Invalid code|Invalid input|code has expired|already exists|rate limit|too many requests|unable to continue/i,
  );
  return match?.[0] || "";
}

function navigationFailureReason(state) {
  if (!state) return "";
  const text = [state.href, state.title, state.text].filter(Boolean).join("\n");
  if (/407 Proxy Authentication Required/i.test(text)) return "代理服务器拒绝了当前目标站点";
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(text)) return "代理隧道连接失败";
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_PROXY_AUTH_UNSUPPORTED/i.test(text)) {
    return "代理连接失败";
  }
  if (/This site can.t be reached|This page isn.t working/i.test(text) && /ERR_/i.test(text)) {
    return text.match(/ERR_[A-Z0-9_]+/i)?.[0] || "浏览器导航失败";
  }
  return "";
}
