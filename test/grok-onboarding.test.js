import test from "node:test";
import assert from "node:assert/strict";
import { clickCompleteSignUp } from "../src/providers/grok/onboarding.js";

test("Grok 注册按钮使用浏览器级鼠标事件点击", async () => {
  const calls = [];
  let expression = "";
  const cdp = {
    async evaluate(value) {
      expression = value;
      return { ok: true, x: 120, y: 240 };
    },
    async send(method, params) {
      calls.push({ method, params });
    },
  };

  await clickCompleteSignUp(cdp);

  assert.doesNotMatch(expression, /requestSubmit/);
  assert.doesNotMatch(expression, /button\.click/);
  assert.deepEqual(calls, [
    {
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: 120, y: 240 },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mousePressed",
        x: 120,
        y: 240,
        button: "left",
        clickCount: 1,
      },
    },
    {
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseReleased",
        x: 120,
        y: 240,
        button: "left",
        clickCount: 1,
      },
    },
  ]);
});

test("Grok 注册按钮不可用时不发送鼠标事件", async () => {
  let sent = false;
  const cdp = {
    async evaluate() {
      return { ok: false, reason: "完成注册按钮当前不可见" };
    },
    async send() {
      sent = true;
    },
  };

  await assert.rejects(
    clickCompleteSignUp(cdp),
    /未能提交 Grok 注册资料：完成注册按钮当前不可见/,
  );
  assert.equal(sent, false);
});
