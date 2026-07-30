import { throwIfAborted, waitWithSignal } from "../../../core/abort.js";
import { emitOAuthTrace, redactOAuthURL } from "./redaction.js";
import { oauthProtocolError, validateXaiOAuthEndpoint } from "./utils.js";

export async function approveXaiDeviceCodeInBrowser(cdp, deviceCode, {
  signal,
  trace = () => {},
  wait = waitWithSignal,
  timeoutMs = 90000,
} = {}) {
  if (!cdp?.send || !cdp?.evaluate) {
    throw new Error("xAI OAuth 浏览器授权需要可用的 CDP 页面连接。");
  }
  const userCode = String(deviceCode?.user_code || "").trim();
  const verificationUrl = validateXaiOAuthEndpoint(
    deviceCode?.verification_uri_complete || deviceCode?.verification_uri,
    "verification_uri",
  );
  if (!userCode) throw new Error("xAI OAuth 设备码响应缺少 user_code。");

  emitOAuthTrace(trace, "浏览器访问设备验证页", {
    url: redactOAuthURL(verificationUrl),
  });
  const navigation = await cdp.send("Page.navigate", { url: verificationUrl });
  if (navigation?.errorText) {
    throw oauthProtocolError(
      `xAI OAuth 浏览器打开设备验证页失败：${navigation.errorText}`,
      "browser_navigation_failed",
    );
  }

  let state = await waitForXaiBrowserDeviceState(cdp, {
    signal,
    trace,
    wait,
    timeoutMs,
    accept: (value) => value.verifyForm || value.approveForm || value.done,
  });
  if (state.done) return;

  if (state.verifyForm) {
    const submitted = await submitXaiBrowserVerifyForm(cdp, userCode);
    if (!submitted?.submitted) {
      throw oauthProtocolError(
        "xAI OAuth 浏览器设备码表单提交失败。",
        "browser_verify_failed",
      );
    }
    emitOAuthTrace(trace, "浏览器提交设备码", {});
    state = await waitForXaiBrowserDeviceState(cdp, {
      signal,
      trace,
      wait,
      timeoutMs,
      accept: (value) => value.approveForm || value.done,
    });
    if (state.done) return;
  }

  const approved = await submitXaiBrowserApproveForm(cdp, userCode);
  if (!approved?.submitted) {
    throw oauthProtocolError(
      "xAI OAuth 浏览器授权确认表单提交失败。",
      "browser_approval_failed",
    );
  }
  emitOAuthTrace(trace, "浏览器提交授权确认", {
    form_action: redactOAuthURL(approved.action),
  });
  await waitForXaiBrowserDeviceState(cdp, {
    signal,
    trace,
    wait,
    timeoutMs,
    accept: (value) => value.done,
  });
}

async function waitForXaiBrowserDeviceState(cdp, {
  signal,
  trace,
  wait,
  timeoutMs,
  accept,
}) {
  const deadline = Date.now() + Math.max(5000, Number(timeoutMs) || 90000);
  let lastState = null;
  let lastHref = "";
  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      lastState = await readXaiBrowserDeviceState(cdp);
    } catch {
      await wait(250, signal);
      continue;
    }
    if (lastState.href !== lastHref) {
      lastHref = lastState.href;
      emitOAuthTrace(trace, "浏览器授权页面变化", {
        url: redactOAuthURL(lastState.href),
        title: lastState.title,
        verify_form: lastState.verifyForm,
        approve_form: lastState.approveForm,
        done: lastState.done,
      });
    }
    if (lastState.signIn) {
      throw new Error("xAI OAuth 自动授权失败：浏览器中的 SSO 登录状态已经失效。");
    }
    if (lastState.blocked) {
      throw oauthProtocolError(
        "xAI OAuth 浏览器页面受到 Cloudflare 限制。",
        "browser_blocked",
      );
    }
    if (lastState.browserError) {
      throw oauthProtocolError(
        "xAI OAuth 浏览器页面加载失败，请检查当前代理连接。",
        "browser_navigation_failed",
      );
    }
    if (lastState.invalidAction) {
      throw oauthProtocolError(
        "xAI OAuth 浏览器授权表单提交失败：Invalid action。",
        "browser_approval_failed",
      );
    }
    if (accept(lastState)) return lastState;
    await wait(300, signal);
  }
  throwIfAborted(signal);
  throw oauthProtocolError(
    `xAI OAuth 浏览器自动授权等待超时。页面：${redactOAuthURL(lastState?.href || "")}`,
    "browser_timeout",
  );
}

function readXaiBrowserDeviceState(cdp) {
  return cdp.evaluate(`
    (() => {
      const href = location.href;
      const text = document.body?.innerText || "";
      const formPaths = [...document.forms].map((form) => {
        try {
          return new URL(form.getAttribute("action") || href, href).pathname.toLowerCase();
        } catch {
          return "";
        }
      });
      return {
        href,
        title: document.title || "",
        verifyForm: formPaths.includes("/oauth2/device/verify"),
        approveForm: formPaths.includes("/oauth2/device/approve"),
        done: /\\/oauth2\\/device\\/done|\\/device\\/done|device_authorized/i.test(href) ||
          /设备已授权|device (?:is )?authorized|authorization complete|you have authorized/i.test(text),
        signIn: /sign-in|sign-up/i.test(href),
        blocked: /sorry, you have been blocked|attention required|cloudflare ray id/i.test(text),
        browserError: href.startsWith("chrome-error://"),
        invalidAction: /invalid action/i.test(text),
      };
    })()
  `);
}

function submitXaiBrowserVerifyForm(cdp, userCode) {
  return cdp.evaluate(`
    (() => {
      const form = [...document.forms].find((item) => {
        try {
          return new URL(item.getAttribute("action") || location.href, location.href).pathname ===
            "/oauth2/device/verify";
        } catch {
          return false;
        }
      });
      if (!form) return { submitted: false, action: "" };
      const input = form.elements.namedItem("user_code");
      if (input) input.value = ${JSON.stringify(userCode)};
      const submitter = form.querySelector('button[type="submit"], input[type="submit"]');
      if (typeof form.requestSubmit === "function") form.requestSubmit(submitter || undefined);
      else HTMLFormElement.prototype.submit.call(form);
      return { submitted: true, action: form.getAttribute("action") || "" };
    })()
  `);
}

function submitXaiBrowserApproveForm(cdp, userCode) {
  return cdp.evaluate(`
    (() => {
      const form = [...document.forms].find((item) => {
        try {
          return new URL(item.getAttribute("action") || location.href, location.href).pathname ===
            "/oauth2/device/approve";
        } catch {
          return false;
        }
      });
      if (!form) return { submitted: false, action: "" };
      const values = {
        user_code: ${JSON.stringify(userCode)},
        action: "allow",
        principal_type: "User",
      };
      for (const [name, value] of Object.entries(values)) {
        let input = form.elements.namedItem(name);
        if (!input) {
          input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          form.append(input);
        }
        input.value = value;
      }
      const action = form.getAttribute("action") || "";
      HTMLFormElement.prototype.submit.call(form);
      return { submitted: true, action };
    })()
  `);
}
