import { CdpClient, findClaudePage } from "../../cdp-client.js";

const debugPort = Number(process.argv[2]);
const url = process.argv[3];
if (!debugPort || !url) {
  throw new Error("用法：node src/tools/claude/navigate-current.js <DevTools端口> <地址>");
}

const page = await findClaudePage(debugPort);
const cdp = new CdpClient(page.webSocketDebuggerUrl);
await cdp.connect();
try {
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url });
  await wait(8000);
  const state = await cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 3000) || "",
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
    links: [...document.querySelectorAll("a")].slice(0, 20).map((el, i) => ({
      i,
      text: el.textContent?.trim(),
      href: el.href,
    })),
  })`);
  console.log(JSON.stringify(state, null, 2));
} finally {
  cdp.close();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
