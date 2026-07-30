export async function fillGrokInput(cdp, selector, value, {
  missingMessage = `未找到 Grok 输入框：${selector}`,
} = {}) {
  const documentNode = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const inputNode = await cdp.send("DOM.querySelector", {
    nodeId: documentNode.root.nodeId,
    selector,
  });
  if (!inputNode.nodeId) throw new Error(missingMessage);
  await cdp.send("DOM.focus", { nodeId: inputNode.nodeId });
  await clearFocusedGrokInput(cdp);
  await cdp.send("Input.insertText", { text: String(value) });
}

export async function clearFocusedGrokInput(cdp) {
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
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
  });
}

export async function dispatchGrokClick(cdp, point) {
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
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

export async function clickGrokElementByText(cdp, pattern) {
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
  await dispatchGrokClick(cdp, point);
}
