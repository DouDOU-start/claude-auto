import { CdpClient, findClaudePage } from "../../cdp-client.js";

const debugPort = Number(process.argv[2]);
const value = process.argv[3];
if (!debugPort || !value) {
  throw new Error("用法：node src/tools/claude/fill-input-continue.js <DevTools端口> <值>");
}

const page = await findClaudePage(debugPort);
const cdp = new CdpClient(page.webSocketDebuggerUrl);
await cdp.connect();
try {
  const action = await cdp.evaluate(`
    (() => {
      const input = [...document.querySelectorAll("input, textarea")]
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !el.disabled;
        });
      if (!input) return { ok: false, reason: "未找到可见输入框" };
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, ${JSON.stringify(value)});
      else input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        value: input.value,
        placeholder: input.getAttribute("placeholder"),
        aria: input.getAttribute("aria-label")
      };
    })()
  `);
  await wait(800);
  const clicked = await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll("button")]
        .find((el) => /continue|next|submit/i.test(el.textContent || "") && !el.disabled);
      if (!button) return { clicked: false, reason: "未找到可用的继续按钮" };
      button.click();
      return { clicked: true, text: button.textContent?.trim() };
    })()
  `);
  await wait(8000);
  const state = await cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 5000) || "",
    inputs: [...document.querySelectorAll("input, textarea, select")].map((el, i) => {
      const rect = el.getBoundingClientRect();
      return {
        i,
        tag: el.tagName,
        type: el.getAttribute("type"),
        name: el.getAttribute("name"),
        id: el.id,
        placeholder: el.getAttribute("placeholder"),
        aria: el.getAttribute("aria-label"),
        value: el.value,
        visible: rect.width > 0 && rect.height > 0
      };
    }),
    buttons: [...document.querySelectorAll("button")].map((el, i) => ({ i, text: el.textContent?.trim(), disabled: el.disabled })).filter((x) => x.text)
  })`);
  console.log(JSON.stringify({ action, clicked, state }, null, 2));
} finally {
  cdp.close();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
