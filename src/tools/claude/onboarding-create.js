import { CdpClient, findClaudePage } from "../../cdp-client.js";

const debugPort = Number(process.argv[2]);
if (!debugPort) {
  throw new Error("用法：node src/tools/claude/onboarding-create.js <DevTools端口>");
}

const page = await findClaudePage(debugPort);
const cdp = new CdpClient(page.webSocketDebuggerUrl);
await cdp.connect();
try {
  const before = await cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 3000) || "",
    checkboxes: [...document.querySelectorAll('input[type="checkbox"]')].map((el, i) => ({ i, checked: el.checked })),
    buttons: [...document.querySelectorAll("button")].map((el, i) => ({ i, text: el.textContent?.trim(), disabled: el.disabled }))
  })`);

  const action = await cdp.evaluate(`
    (() => {
      const boxes = [...document.querySelectorAll('input[type="checkbox"]')];
      const setChecked = (input, checked) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
        if (setter) setter.call(input, checked);
        else input.checked = checked;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      };
      if (boxes[0]) setChecked(boxes[0], true);
      if (boxes[1]) setChecked(boxes[1], false);
      const button = [...document.querySelectorAll("button")]
        .find((el) => /create account/i.test(el.textContent || ""));
      if (!button) return { ok: false, reason: "未找到创建账号按钮" };
      button.click();
      return {
        ok: true,
        checkboxes: boxes.map((el, i) => ({ i, checked: el.checked })),
        button: button.textContent?.trim()
      };
    })()
  `);

  await wait(10000);
  const after = await cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 5000) || "",
    inputs: [...document.querySelectorAll("input, textarea, select")].map((el, i) => ({
      i,
      tag: el.tagName,
      type: el.getAttribute("type"),
      name: el.getAttribute("name"),
      id: el.id,
      placeholder: el.getAttribute("placeholder"),
      aria: el.getAttribute("aria-label"),
      value: el.value,
    })),
    buttons: [...document.querySelectorAll("button")].map((el, i) => ({ i, text: el.textContent?.trim(), disabled: el.disabled })).filter((x) => x.text)
  })`);
  console.log(JSON.stringify({ before, action, after }, null, 2));
} finally {
  cdp.close();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
