import { throwIfAborted, waitWithSignal } from "../../core/abort.js";

export async function completeGrokOnboarding(cdp, {
  givenName,
  familyName,
  password,
  signal,
}) {
  await fillInput(cdp, 'input[data-testid="givenName"]', givenName);
  await fillInput(cdp, 'input[data-testid="familyName"]', familyName);
  await fillInput(cdp, 'input[data-testid="password"]', password);
  await submitCompleteSignUp(cdp);

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

async function fillInput(cdp, selector, value) {
  const documentNode = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const inputNode = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!inputNode.nodeId) throw new Error(`未找到 Grok 注册输入框：${selector}`);
  await cdp.send("DOM.focus", { nodeId: inputNode.nodeId });
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
  await cdp.send("Input.insertText", { text: String(value) });
}

async function submitCompleteSignUp(cdp) {
  const result = await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll("button")]
        .find((item) => /Complete sign up/i.test(item.textContent || "") && !item.disabled);
      if (!button) return { ok: false, reason: "未找到完成注册按钮" };
      const form = button.closest("form");
      if (!form) return { ok: false, reason: "完成注册按钮不在表单中" };
      if (!form.checkValidity()) {
        return { ok: false, reason: "注册资料未通过浏览器表单校验" };
      }
      button.scrollIntoView({ block: "center", inline: "center" });
      if (typeof form.requestSubmit === "function") {
        form.requestSubmit(button);
        return { ok: true, mode: "requestSubmit" };
      }
      button.click();
      return { ok: true, mode: "click" };
    })()
  `);
  if (!result?.ok) throw new Error(`未能提交 Grok 注册资料：${result?.reason || "未知原因"}`);
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
