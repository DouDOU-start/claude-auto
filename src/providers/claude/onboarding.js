import { throwIfAborted, waitWithSignal } from "../../core/abort.js";
import { parseBirthday } from "./profile.js";

export async function completeClaudeOnboarding(cdp, { displayName, birthday, signal }) {
  for (let step = 0; step < 16; step += 1) {
    throwIfAborted(signal);
    const state = await pageState(cdp);
    const text = state.text || "";
    if (/Your first chat with Claude|Welcome,\s*/i.test(text) && /Free plan/i.test(text)) return state;

    if (/Let.s create your account/i.test(text)) {
      await clickTermsAndCreate(cdp, signal);
    } else if (/How are you planning to use Claude/i.test(text)) {
      await clickButtonByText(cdp, /For personal use/i);
    } else if (/Plans that grow with you/i.test(text)) {
      await clickButtonByText(cdp, /Use Claude for free/i);
    } else if (/Get the most out of Claude on your desktop/i.test(text)) {
      await clickButtonByText(cdp, /Skip/i);
    } else if (/Before your first chat/i.test(text)) {
      await clickButtonByText(cdp, /Continue/i);
    } else if (/When is your birthday/i.test(text)) {
      await fillBirthday(cdp, birthday);
      await clickButtonByText(cdp, /Continue/i);
    } else if (/What.s your name/i.test(text)) {
      await fillFirstVisibleInput(cdp, displayName);
      await clickButtonByText(cdp, /Continue/i);
    } else if (/What kind of work do you do/i.test(text)) {
      await clickButtonByText(cdp, /Set up later/i);
    } else if (/Verify your phone number|Enter your phone number/i.test(text)) {
      const details = await diagnosticState(cdp).catch(() => state);
      throw new Error(`需要手机验证。页面状态：${JSON.stringify(details)}`);
    } else {
      const details = await diagnosticState(cdp).catch(() => state);
      throw new Error(`无法识别的新用户引导步骤。页面状态：${JSON.stringify(details)}`);
    }
    await waitWithSignal(5000, signal);
  }
  const details = await diagnosticState(cdp).catch(() => null);
  throw new Error(`新用户引导未能在预期步骤内完成。页面状态：${JSON.stringify(details)}`);
}

async function clickTermsAndCreate(cdp, signal) {
  const before = await accountCreationTargets(cdp);
  if (!before?.button && !before?.checkbox) {
    const details = await diagnosticState(cdp).catch(() => before);
    throw new Error(`未找到条款复选框或创建账号按钮。页面状态：${JSON.stringify(details)}`);
  }

  if (before.checkbox && !before.checkbox.checked) {
    await click(cdp, before.checkbox.x, before.checkbox.y);
    await waitWithSignal(900, signal);
  }

  const after = await accountCreationTargets(cdp);
  const button = after?.button || before.button;
  if (!button) {
    const details = await diagnosticState(cdp).catch(() => after || before);
    throw new Error(`勾选条款后仍未找到创建账号按钮。页面状态：${JSON.stringify(details)}`);
  }
  await click(cdp, button.x, button.y);
}

async function accountCreationTargets(cdp) {
  return cdp.evaluate(`
    (() => {
      const isVisible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const center = (el) => {
        el.scrollIntoView({ block: "center", inline: "center" });
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };
      const textOf = (el) => (el.textContent || el.getAttribute("aria-label") || "").trim();
      const checkedState = (el) => {
        if (el.matches?.('input[type="checkbox"]')) return Boolean(el.checked);
        const aria = el.getAttribute("aria-checked");
        if (aria === "true") return true;
        if (aria === "false") return false;
        const state = el.getAttribute("data-state");
        if (state === "checked") return true;
        if (state === "unchecked") return false;
        return false;
      };

      const checkboxCandidates = [
        ...document.querySelectorAll('input[type="checkbox"], [role="checkbox"], [aria-checked], [data-state="checked"], [data-state="unchecked"]'),
        ...[...document.querySelectorAll("label")].filter((el) => /agree|terms|privacy|policy|age|18/i.test(textOf(el))),
      ].filter(isVisible);

      const checkbox = checkboxCandidates[0] || null;
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter((el) => isVisible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
      const button =
        buttons.find((el) => /create account|continue|agree|accept/i.test(textOf(el))) ||
        buttons.find((el) => !/use a different email|different email|back|sign in|log in/i.test(textOf(el))) ||
        null;

      let checkboxResult = null;
      let buttonResult = null;
      if (checkbox) {
        const point = center(checkbox);
        checkboxResult = {
          ...point,
          checked: checkedState(checkbox),
          text: textOf(checkbox),
          tagName: checkbox.tagName.toLowerCase(),
          role: checkbox.getAttribute("role"),
          ariaChecked: checkbox.getAttribute("aria-checked"),
          dataState: checkbox.getAttribute("data-state")
        };
      }

      if (button) {
        const point = center(button);
        buttonResult = {
          ...point,
          text: textOf(button),
          tagName: button.tagName.toLowerCase()
        };
      }

      return {
        checkbox: checkboxResult,
        button: buttonResult,
        buttons: buttons.map((el, index) => ({ index, text: textOf(el) })).slice(0, 8),
        checkboxCandidates: checkboxCandidates.map((el, index) => ({
          index,
          text: textOf(el),
          tagName: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          ariaChecked: el.getAttribute("aria-checked"),
          dataState: el.getAttribute("data-state")
        })).slice(0, 8)
      };
    })()
  `);
}

async function clickButtonByText(cdp, pattern) {
  const point = await cdp.evaluate(`
    (() => {
      const re = new RegExp(${JSON.stringify(pattern.source)}, ${JSON.stringify(pattern.flags)});
      const button = [...document.querySelectorAll("button")]
        .find((el) => re.test(el.textContent || "") && !el.disabled);
      if (!button) return null;
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: button.textContent?.trim() };
    })()
  `);
  if (!point) throw new Error(`未找到按钮：${pattern}`);
  await click(cdp, point.x, point.y);
  return point;
}

async function click(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function fillFirstVisibleInput(cdp, value) {
  const result = await cdp.evaluate(`
    (() => {
      const input = [...document.querySelectorAll("input, textarea")]
        .find((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !el.disabled;
        });
      if (!input) return { ok: false };
      input.focus();
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, ${JSON.stringify(value)});
      else input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: input.value };
    })()
  `);
  if (!result?.ok) throw new Error("未找到可见输入框。");
}

async function fillBirthday(cdp, value) {
  const parts = parseBirthday(value);
  const result = await cdp.evaluate(`
    (() => {
      const inputs = [...document.querySelectorAll("input")]
        .filter((el) => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && !el.disabled;
        });
      const setValue = (input, nextValue) => {
        input.scrollIntoView({ block: "center", inline: "center" });
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, nextValue);
        else input.value = nextValue;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.dispatchEvent(new Event("blur", { bubbles: true }));
      };
      const findSegment = (name, placeholder, label) =>
        inputs.find((el) => (el.name || "").toLowerCase() === name) ||
        inputs.find((el) => (el.placeholder || "").toLowerCase() === placeholder) ||
        inputs.find((el) => (el.getAttribute("aria-label") || "").toLowerCase() === label);
      const month = findSegment("month", "mm", "month");
      const day = findSegment("day", "dd", "day");
      const year = findSegment("year", "yyyy", "year");
      if (month && day && year) {
        setValue(month, ${JSON.stringify(parts.month)});
        setValue(day, ${JSON.stringify(parts.day)});
        setValue(year, ${JSON.stringify(parts.year)});
        return {
          ok: true,
          mode: "segments",
          values: { month: month.value, day: day.value, year: year.value }
        };
      }
      const input =
        inputs.find((el) => /birth|date/i.test([el.name, el.id, el.placeholder, el.getAttribute("aria-label")].join(" "))) ||
        inputs[0];
      if (!input) return { ok: false, reason: "未找到生日输入框" };
      setValue(input, ${JSON.stringify(value)});
      return {
        ok: true,
        mode: "single",
        value: input.value,
        name: input.name,
        id: input.id,
        placeholder: input.placeholder,
        ariaLabel: input.getAttribute("aria-label")
      };
    })()
  `);
  if (!result?.ok) throw new Error(`未找到生日输入框。页面状态：${JSON.stringify(result)}`);
}

async function pageState(cdp) {
  return cdp.evaluate(`({
    href: location.href,
    title: document.title,
    text: document.body?.innerText?.slice(0, 7000) || "",
    hasEmailInput: Boolean(document.querySelector('input#email, input[type="email"], input[data-testid="email"]'))
  })`);
}

async function diagnosticState(cdp) {
  return cdp.evaluate(`
    (() => ({
      href: location.href,
      title: document.title,
      text: document.body?.innerText?.slice(0, 1200) || "",
      buttons: [...document.querySelectorAll("button")].map((button, index) => ({
        index,
        text: button.textContent?.trim() || "",
        disabled: button.disabled,
        ariaDisabled: button.getAttribute("aria-disabled")
      })),
      inputs: [...document.querySelectorAll("input, textarea")].map((input, index) => ({
        index,
        type: input.type || input.tagName.toLowerCase(),
        value: input.type === "password" ? "" : input.value,
        checked: Boolean(input.checked),
        disabled: input.disabled,
        name: input.name,
        id: input.id,
        placeholder: input.placeholder,
        ariaLabel: input.getAttribute("aria-label")
      }))
    }))()
  `);
}
