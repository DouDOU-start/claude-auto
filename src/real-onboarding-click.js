import { CdpClient, findClaudePage } from "./cdp-client.js";

const debugPort = Number(process.argv[2]);
if (!debugPort) {
  throw new Error("用法：node src/real-onboarding-click.js <DevTools端口>");
}

const page = await findClaudePage(debugPort);
const cdp = new CdpClient(page.webSocketDebuggerUrl);
await cdp.connect();
try {
  await cdp.send("Input.setIgnoreInputEvents", { ignore: false }).catch(() => {});
  const checkboxPoint = await cdp.evaluate(`
    (() => {
      const input = [...document.querySelectorAll('input[type="checkbox"]')][0];
      if (!input) return null;
      input.scrollIntoView({ block: "center", inline: "center" });
      const rect = input.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, checked: input.checked };
    })()
  `);
  if (!checkboxPoint) throw new Error("未找到条款复选框");
  if (!checkboxPoint.checked) {
    await click(cdp, checkboxPoint.x, checkboxPoint.y);
    await wait(800);
  }

  const buttonPoint = await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll('button')]
        .find((el) => /create account/i.test(el.textContent || ""));
      if (!button) return null;
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        disabled: button.disabled,
        text: button.textContent?.trim()
      };
    })()
  `);
  if (!buttonPoint) throw new Error("未找到创建账号按钮");
  if (buttonPoint.disabled) throw new Error("创建账号按钮不可用");
  await click(cdp, buttonPoint.x, buttonPoint.y);
  await wait(12000);

  const state = await cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 6000) || "",
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
        checked: el.checked,
        visible: rect.width > 0 && rect.height > 0
      };
    }),
    buttons: [...document.querySelectorAll("button")].map((el, i) => ({
      i,
      text: el.textContent?.trim(),
      disabled: el.disabled,
      type: el.getAttribute("type")
    })).filter((item) => item.text),
    links: [...document.querySelectorAll("a")].slice(0, 25).map((el, i) => ({
      i,
      text: el.textContent?.trim(),
      href: el.href
    }))
  })`);
  console.log(JSON.stringify({ checkboxPoint, buttonPoint, state }, null, 2));
} finally {
  cdp.close();
}

async function click(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
