import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseProxyUrl, startProxyBridge } from "./proxy-bridge.js";
import { CdpClient, findClaudePage } from "./cdp-client.js";
import { resolveBrowserPath } from "./browser-utils.js";
import { maskProxy, resolveProxyUrl } from "./config.js";

const DEFAULT_CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEFAULT_BIRTHDAY = "01/01/1995";
const FIRST_NAMES = [
  "Alex",
  "Taylor",
  "Jordan",
  "Morgan",
  "Casey",
  "Riley",
  "Avery",
  "Jamie",
  "Quinn",
  "Cameron",
  "Drew",
  "Reese",
];
const LAST_NAMES = [
  "Morgan",
  "Parker",
  "Reed",
  "Brooks",
  "Hayes",
  "Cole",
  "Bennett",
  "Foster",
  "Miller",
  "Stone",
  "Wells",
  "Harper",
];

main().catch(async (error) => {
  console.error(`ERROR: ${error.message}`);
  if (globalThis.__claudeKeepProcessAlive) {
    console.error("Keeping Chrome and proxy bridge running because manual onboarding is required. Press Ctrl+C to stop.");
    await new Promise(() => {});
  }
  process.exit(1);
});

async function main() {
  const startedAt = Date.now();
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  globalThis.__claudeKeepProcessAlive = false;

  const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const chromePath = resolveBrowserPath({
    requestedPath: args.chrome,
    projectRoot,
    fallbackPath: DEFAULT_CHROME,
  });

  const email = args.email || `test-${randomBytes(5).toString("hex")}@${args.domain || "k9ray.com"}`;
  const displayName = args.name || randomDisplayName();
  const birthday = args.birthday || DEFAULT_BIRTHDAY;
  const proxyUrl = resolveProxyUrl({ requestedProxy: args.proxy, projectRoot });
  const upstream = parseProxyUrl(proxyUrl);
  const keepOpen = Boolean(args.keepOpen);
  const keepOpenOnError = Boolean(args.keepOpenOnError);
  let keepResourcesOpen = keepOpen;
  const profileDir = resolve(
    args.profileDir ||
      join(projectRoot, "profiles", `interactive-${timestamp()}-${randomBytes(4).toString("hex")}`),
  );
  const logDir = resolve(args.logDir || join(projectRoot, "logs"));
  const debugPort = Number(args.debugPort || 0) || randomPortHint();

  await mkdir(join(profileDir, "Default"), { recursive: true });
  await mkdir(logDir, { recursive: true });
  await writeEnglishProfile(profileDir);

  console.log("[1/7] Starting local proxy bridge...");
  const bridge = await startProxyBridge({
    listenHost: "127.0.0.1",
    listenPort: Number(args.bridgePort || 0),
    upstream,
  });

  console.log("[2/7] Opening fresh Chrome profile...");
  const chrome = launchChrome({
    chromePath,
    profileDir,
    proxyServer: `http://${bridge.host}:${bridge.port}`,
    debugPort,
  });

  const rl = createInterface({ input, output });
  let cdp;
  try {
    console.log(`      Profile: ${profileDir}`);
    console.log(`      DevTools port: ${debugPort}`);
    console.log(`      Local proxy: http://${bridge.host}:${bridge.port}`);
    console.log("      Waiting for DevTools...");
    await waitForDevTools(debugPort, Number(args.devtoolsTimeout || 30000));
    cdp = await connectClaudePage(debugPort);
    console.log("      Waiting for Claude login page...");
    await waitForLoginReady(cdp, Number(args.loginTimeout || 90000));
    console.log("      Claude login page is ready.");

    console.log("[3/7] Sending email magic link...");
    await syncVisibleEmailInput(cdp, email);
    const sendResult = await sendMagicLink(cdp, email);
    console.log(JSON.stringify({
      email,
      sent: parseSent(sendResult.responseText),
      status: sendResult.status,
      responseText: sendResult.responseText,
    }, null, 2));

    console.log("[4/7] Paste the Claude magic-link URL from email.");
    const magicUrl = await askNonEmpty(rl, "Magic link URL: ");
    validateMagicUrl(magicUrl, email);

    console.log("[5/7] Opening magic link in the same browser...");
    await navigate(cdp, magicUrl, 10000);
    await dismissCookieBanner(cdp);
    await waitForText(cdp, /Let.s create your account|How are you planning|Plans that grow|Before your first chat|What.s your name|Your first chat/i, 90000);

    console.log("[6/7] Completing onboarding...");
    await completeOnboarding(cdp, { displayName, birthday });

    console.log("[7/7] Reading sessionKey cookie...");
    const session = await getSessionCookies(cdp);
    const duration = elapsed(startedAt);
    const result = {
      email,
      name: displayName,
      birthday,
      durationMs: duration.ms,
      durationSeconds: duration.seconds,
      durationText: duration.text,
      profileDir,
      debugPort,
      localProxy: `http://${bridge.host}:${bridge.port}`,
      upstreamProxy: maskProxy(proxyUrl),
      sessionKey: session.sessionKey?.value || "",
      sessionKeyLC: session.sessionKeyLC?.value || "",
      routingHint: session.routingHint?.value || "",
      cookies: session.interesting,
      completedAt: new Date().toISOString(),
    };

    const outputPath = join(logDir, `interactive-register-${timestamp()}.json`);
    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    console.log(JSON.stringify({
      email,
      name: displayName,
      birthday,
      durationMs: result.durationMs,
      durationSeconds: result.durationSeconds,
      durationText: result.durationText,
      sessionKey: result.sessionKey,
      sessionKeyLC: result.sessionKeyLC,
      profileDir,
      debugPort,
      outputPath,
    }, null, 2));
    console.log(`Total duration: ${duration.text}`);
    if (keepOpen) {
      console.log("Chrome and proxy bridge are kept running. Close Chrome manually when finished.");
    } else {
      console.log("Chrome and proxy bridge closed.");
    }
  } catch (error) {
    if (keepOpenOnError && isManualOnboardingError(error)) {
      keepResourcesOpen = true;
      globalThis.__claudeKeepProcessAlive = true;
    }
    throw error;
  } finally {
    rl.close();
    cdp?.close();
    if (!keepResourcesOpen) {
      await stopChrome(chrome);
      await bridge.close();
    }
  }
}

async function connectClaudePage(debugPort) {
  const page = await findClaudePage(debugPort);
  const cdp = new CdpClient(page.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable").catch(() => {});
  return cdp;
}

async function completeOnboarding(cdp, { displayName, birthday }) {
  for (let step = 0; step < 16; step += 1) {
    const state = await pageState(cdp);
    const text = state.text || "";
    if (/Your first chat with Claude|Welcome,\s*/i.test(text) && /Free plan/i.test(text)) return state;

    if (/Let.s create your account/i.test(text)) {
      await clickTermsAndCreate(cdp);
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
      throw new Error(`Phone verification required. State: ${JSON.stringify(details)}`);
    } else {
      const details = await diagnosticState(cdp).catch(() => state);
      throw new Error(`Unknown onboarding step. State: ${JSON.stringify(details)}`);
    }
    await wait(5000);
  }
  const details = await diagnosticState(cdp).catch(() => null);
  throw new Error(`Onboarding did not complete within expected steps. State: ${JSON.stringify(details)}`);
}

async function clickTermsAndCreate(cdp) {
  const before = await accountCreationTargets(cdp);
  if (!before?.button && !before?.checkbox) {
    const details = await diagnosticState(cdp).catch(() => before);
    throw new Error(`Terms checkbox or account creation button not found. State: ${JSON.stringify(details)}`);
  }

  if (before.checkbox && !before.checkbox.checked) {
    await click(cdp, before.checkbox.x, before.checkbox.y);
    await wait(900);
  }

  const after = await accountCreationTargets(cdp);
  const button = after?.button || before.button;
  if (!button) {
    const details = await diagnosticState(cdp).catch(() => after || before);
    throw new Error(`Account creation button not found after terms click. State: ${JSON.stringify(details)}`);
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

      if (checkbox) {
        const point = center(checkbox);
        var checkboxResult = {
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
        var buttonResult = {
          ...point,
          text: textOf(button),
          tagName: button.tagName.toLowerCase()
        };
      }

      return {
        checkbox: checkboxResult || null,
        button: buttonResult || null,
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
  const source = pattern.source;
  const flags = pattern.flags;
  const point = await cdp.evaluate(`
    (() => {
      const re = new RegExp(${JSON.stringify(source)}, ${JSON.stringify(flags)});
      const button = [...document.querySelectorAll("button")]
        .find((el) => re.test(el.textContent || "") && !el.disabled);
      if (!button) return null;
      button.scrollIntoView({ block: "center", inline: "center" });
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: button.textContent?.trim() };
    })()
  `);
  if (!point) throw new Error(`Button not found: ${pattern}`);
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
  if (!result?.ok) throw new Error("Visible input not found.");
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
      const setValue = (input, value) => {
        input.scrollIntoView({ block: "center", inline: "center" });
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (setter) setter.call(input, value);
        else input.value = value;
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
          values: {
            month: month.value,
            day: day.value,
            year: year.value
          }
        };
      }
      const input =
        inputs.find((el) => /birth|date/i.test([el.name, el.id, el.placeholder, el.getAttribute("aria-label")].join(" "))) ||
        inputs[0];
      if (!input) return { ok: false, reason: "birthday input not found" };
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
  if (!result?.ok) throw new Error(`Birthday input not found. State: ${JSON.stringify(result)}`);
}

async function dismissCookieBanner(cdp) {
  await cdp.evaluate(`
    (() => {
      const button = [...document.querySelectorAll("button")]
        .find((el) => /reject.*cookies|reject/i.test(el.textContent || ""));
      if (button) button.click();
      return Boolean(button);
    })()
  `).catch(() => false);
  await wait(1500);
}

async function navigate(cdp, url, waitMs) {
  await cdp.send("Page.navigate", { url });
  await wait(waitMs);
}

async function waitForLoginReady(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await pageState(cdp).catch(() => null);
    const failureReason = navigationFailureReason(lastState);
    if (failureReason) {
      throw new Error(`Claude login page not ready. ${failureReason}. Last state: ${JSON.stringify(lastState)}`);
    }
    if (
      lastState?.href?.includes("claude.ai/login") &&
      lastState?.title === "Sign in - Claude" &&
      lastState?.hasEmailInput
    ) {
      return lastState;
    }
    await wait(700);
  }
  throw new Error(`Claude login page not ready. Last state: ${JSON.stringify(lastState)}`);
}

function navigationFailureReason(state) {
  if (!state) return "";
  const text = [state.href, state.title, state.text].filter(Boolean).join("\n");
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(text)) return "ERR_TUNNEL_CONNECTION_FAILED";
  if (/ERR_PROXY_CONNECTION_FAILED|ERR_NO_SUPPORTED_PROXIES|ERR_PROXY_AUTH_UNSUPPORTED/i.test(text)) {
    return "Proxy connection failed";
  }
  if (/This site can.t be reached|This page isn.t working/i.test(text) && /ERR_/i.test(text)) {
    const match = text.match(/ERR_[A-Z0-9_]+/i);
    return match?.[0] || "Browser navigation failed";
  }
  return "";
}

async function waitForText(cdp, regex, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await pageState(cdp).catch(() => null);
    if (state?.text && regex.test(state.text)) return state;
    await wait(1000);
  }
  throw new Error(`Expected page text not found. Last state: ${JSON.stringify(state)}`);
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

async function syncVisibleEmailInput(cdp, email) {
  return cdp.evaluate(`
    (() => {
      const input = document.querySelector('input#email, input[type="email"], input[data-testid="email"]');
      if (!input) return { ok: false };
      input.scrollIntoView({ block: "center", inline: "center" });
      input.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (setter) setter.call(input, ${JSON.stringify(email)});
      else input.value = ${JSON.stringify(email)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: input.value };
    })()
  `);
}

async function sendMagicLink(cdp, email) {
  return cdp.evaluate(`
    (async () => {
      const body = {
        utc_offset: new Date().getTimezoneOffset() * -1,
        email_address: ${JSON.stringify(email)},
        login_intent: null,
        locale: document.documentElement.lang || navigator.language || "en-US",
        return_to: null,
        source: "claude"
      };
      const response = await fetch("/api/auth/send_magic_link", {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "anthropic-client-platform": "web_claude_ai",
          "anthropic-client-version": document.documentElement.dataset.version || "1.0.0",
          "anthropic-client-sha": document.documentElement.dataset.gitHash || document.documentElement.dataset.buildId || "",
          "anthropic-device-id": document.cookie.match(/(?:^|; )anthropic-device-id=([^;]+)/)?.[1] || "",
          "anthropic-anonymous-id": document.cookie.match(/(?:^|; )ajs_anonymous_id=([^;]+)/)?.[1] || ""
        },
        body: JSON.stringify(body)
      });
      return {
        requestBody: body,
        status: response.status,
        statusText: response.statusText,
        responseText: await response.text(),
        responseHeaders: Object.fromEntries(response.headers.entries())
      };
    })()
  `);
}

async function getSessionCookies(cdp) {
  const result = await cdp.send("Network.getCookies", {
    urls: ["https://claude.ai/", "https://claude.ai/chat", "https://platform.claude.com/"],
  });
  const cookies = result.cookies || [];
  const interesting = cookies.filter((cookie) => /session|sk|key|auth|token|routing/i.test(cookie.name));
  return {
    interesting,
    sessionKey: cookies.find((cookie) => cookie.name === "sessionKey" && cookie.domain.includes("claude.ai")),
    sessionKeyLC: cookies.find((cookie) => cookie.name === "sessionKeyLC"),
    routingHint: cookies.find((cookie) => cookie.name === "routingHint"),
  };
}

async function writeEnglishProfile(profileDir) {
  const prefs = {
    autofill: { credit_card_enabled: false, profile_enabled: false },
    credentials_enable_service: false,
    intl: { accept_languages: "en-US,en" },
    payments: { can_make_payment_enabled: false },
    profile: { password_manager_enabled: false },
    webkit: { webprefs: { default_encoding: "UTF-8" } },
  };
  const localState = { intl: { app_locale: "en-US" }, browser: { enabled_labs_experiments: [] } };
  await writeFile(join(profileDir, "Default", "Preferences"), JSON.stringify(prefs, null, 2), "utf8");
  await writeFile(join(profileDir, "Local State"), JSON.stringify(localState, null, 2), "utf8");
}

function launchChrome({ chromePath, profileDir, proxyServer, debugPort }) {
  return spawn(chromePath, [
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-save-password-bubble",
    "--lang=en-US",
    "--accept-lang=en-US,en",
    "--timezone=America/New_York",
    "--new-window",
    `--proxy-server=${proxyServer}`,
    `--remote-debugging-port=${debugPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "https://claude.ai/login",
  ], { detached: true, stdio: "ignore" });
}

async function waitForDevTools(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await wait(300);
  }
  throw new Error(`DevTools port did not open: ${port}`);
}

async function askNonEmpty(rl, question) {
  while (true) {
    const answer = (await rl.question(question)).trim();
    if (answer) return answer;
  }
}

function validateMagicUrl(url, email) {
  const parsed = new URL(url);
  if (parsed.hostname !== "claude.ai" || !parsed.pathname.includes("/magic-link")) {
    throw new Error("URL is not a claude.ai magic-link URL.");
  }
  const encodedEmail = parsed.hash.split(":")[1] || "";
  if (!encodedEmail) return;
  try {
    const decoded = Buffer.from(encodedEmail, "base64").toString("utf8");
    if (decoded.toLowerCase() !== email.toLowerCase()) {
      throw new Error(`Magic link email mismatch. Expected ${email}, got ${decoded}`);
    }
  } catch (error) {
    if (error.message.includes("mismatch")) throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === "--help" || item === "-h") args.help = true;
    else if (item === "--no-keep-open") args.noKeepOpen = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) args[key] = true;
      else {
        args[key] = value;
        i += 1;
      }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
Usage:
  node src/interactive-register.js [options]

Options:
  --email <email>          Email to register. Default: random @k9ray.com.
  --domain <domain>        Random email domain when --email is omitted. Default: k9ray.com.
  --name <name>            Display name. Default: random English name.
  --birthday <MM/DD/YYYY>  Birthdate for onboarding. Default: ${DEFAULT_BIRTHDAY}.
  --proxy <proxy-url>      Upstream auth proxy. Overrides config/proxy.json.
  --chrome <path>          Chrome/Chromium executable path. Default: bundled Chromium.
  --bridge-port <port>     Local no-auth proxy bridge port. Default: random.
  --debug-port <port>      Chrome DevTools port. Default: random high port.
  --profile-dir <path>     Chrome profile directory. Default: ./profiles/interactive-...
  --log-dir <path>         Result JSON directory. Default: ./logs.
  --keep-open              Keep Chrome and proxy bridge running after completion.
  --keep-open-on-error     Keep Chrome only when onboarding needs manual action.
  --help                   Show this help.

Flow:
  1. Opens a fresh proxied Chrome profile.
  2. Sends magic link to the email.
  3. Prompts you to paste the magic-link URL.
  4. Completes onboarding automatically.
  5. Prints sessionKey from cookies.
`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChrome(chrome) {
  if (!chrome?.pid) return;
  if (process.platform === "win32") {
    await runIgnore("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], 7000);
    return;
  }

  try {
    process.kill(-chrome.pid, "SIGTERM");
  } catch {
    try {
      chrome.kill();
    } catch {}
  }
  await wait(1000);
  try {
    process.kill(-chrome.pid, "SIGKILL");
  } catch {}
}

function runIgnore(command, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolveRun();
    }, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolveRun();
    };
    child.once("exit", done);
    child.once("error", done);
  });
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

function randomPortHint() {
  return 40000 + Math.floor(Math.random() * 20000);
}

function randomDisplayName() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}

function parseBirthday(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error(`Birthday must use MM/DD/YYYY format: ${value}`);
  return {
    month: match[1].padStart(2, "0"),
    day: match[2].padStart(2, "0"),
    year: match[3],
  };
}

function elapsed(startedAt) {
  const ms = Date.now() - startedAt;
  return {
    ms,
    seconds: Number((ms / 1000).toFixed(2)),
    text: formatDuration(ms),
  };
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function parseSent(responseText) {
  try {
    return Boolean(JSON.parse(responseText).sent);
  } catch {
    return false;
  }
}

function isManualOnboardingError(error) {
  return /Phone verification required/i.test(error?.message || "");
}
