import { CdpClient, findClaudePage } from "../../cdp-client.js";

const debugPort = Number(process.argv[2]);
const text = process.argv[3];
if (!debugPort || !text) {
  throw new Error("用法：node src/tools/claude/click-and-state.js <DevTools端口> <按钮文字>");
}

const page = await findClaudePage(debugPort);
const cdp = new CdpClient(page.webSocketDebuggerUrl);
await cdp.connect();
try {
  const result = await cdp.evaluate(`
    (() => {
      const wanted = ${JSON.stringify(text)}.toLowerCase();
      const button = [...document.querySelectorAll("button")]
        .find((el) => (el.textContent || "").toLowerCase().includes(wanted));
      if (!button) return { clicked: false, reason: "未找到按钮" };
      button.click();
      return { clicked: true, text: button.textContent?.trim() };
    })()
  `);
  await wait(8000);
  const state = await cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 4000) || "",
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
        visible: rect.width > 0 && rect.height > 0,
      };
    }),
    buttons: [...document.querySelectorAll("button")].map((el, i) => ({
      i,
      text: el.textContent?.trim(),
      disabled: el.disabled,
      type: el.getAttribute("type"),
    })).filter((item) => item.text),
  })`);
  console.log(JSON.stringify({ result, state }, null, 2));
} finally {
  cdp.close();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
