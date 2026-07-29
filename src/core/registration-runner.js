import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { maskProxy } from "../config.js";
import { openBrowserRuntime, timestamp } from "./browser-runtime.js";
import { throwIfAborted } from "./abort.js";

const BASE_TOTAL_STEPS = 7;

export async function runRegistration({
  provider,
  projectRoot,
  email,
  profile,
  proxyUrl = "",
  chromePath = "",
  profileDir = "",
  logDir = "",
  debugPort = 0,
  bridgePort = 0,
  devtoolsTimeout = 30000,
  loginTimeout = 90000,
  keepOpen = false,
  keepOpenOnError = false,
  getVerification,
  getVerificationUrl,
  authorization = { enabled: false },
  onEvent = () => {},
  signal,
  openRuntime = openBrowserRuntime,
}) {
  assertProvider(provider);
  if (!email) throw new Error("缺少注册邮箱。");
  const verificationGetter = getVerification || getVerificationUrl;
  if (typeof verificationGetter !== "function") throw new Error("缺少邮箱验证信息获取方法。");

  const startedAt = Date.now();
  const shouldAuthorize = Boolean(
    authorization?.enabled && typeof provider.authorizeAfterRegistration === "function",
  );
  const totalSteps = BASE_TOTAL_STEPS + (shouldAuthorize ? 1 : 0);
  const actualProfileDir = resolve(
    profileDir ||
      join(
        projectRoot,
        "profiles",
        `${provider.profilePrefix}-${timestamp()}-${randomBytes(4).toString("hex")}`,
      ),
  );
  const actualLogDir = resolve(logDir || join(projectRoot, "logs"));
  const outputPath = join(
    actualLogDir,
    `${provider.resultFilePrefix}-${timestamp()}-${randomBytes(3).toString("hex")}.json`,
  );
  let runtime = null;
  let retainRuntime = false;
  let abortRuntime = null;

  const report = (step, message) => {
    onEvent({ type: "progress", provider: provider.id, step, total: totalSteps, message });
  };

  try {
    throwIfAborted(signal);
    await mkdir(actualLogDir, { recursive: true });
    report(1, "正在启动浏览器运行环境……");
    runtime = await openRuntime({
      projectRoot,
      proxyUrl,
      chromePath,
      profileDir: actualProfileDir,
      debugPort,
      bridgePort,
      startUrl: provider.startUrl,
      pageUrlIncludes: provider.pageUrlIncludes,
      profilePrefix: provider.profilePrefix,
      keepProfile: true,
      devtoolsTimeout,
      signal,
    });
    if (signal) {
      abortRuntime = () => {
        const reason = signal.reason instanceof Error ? signal.reason : new Error("注册操作已取消。");
        runtime?.cdp.close(reason);
      };
      signal.addEventListener("abort", abortRuntime, { once: true });
      if (signal.aborted) abortRuntime();
    }
    onEvent({
      type: "runtime_ready",
      provider: provider.id,
      profileDir: runtime.profileDir,
      debugPort: runtime.debugPort,
      localProxy: localProxyOf(runtime),
    });

    report(2, `正在等待 ${provider.displayName} 登录页……`);
    await provider.waitForLoginReady(runtime.cdp, { timeoutMs: Number(loginTimeout), signal });

    const verificationLabel = provider.verificationLabel || "邮箱验证信息";
    report(3, `正在发送${verificationLabel}……`);
    await provider.submitEmail(runtime.cdp, email, { signal });
    const sendResult = await provider.sendVerification(runtime.cdp, email, { signal });
    onEvent({
      type: "verification_sent",
      provider: provider.id,
      email,
      sent: provider.verificationWasSent(sendResult),
      status: sendResult.status,
      responseText: sendResult.responseText,
    });

    report(4, `正在获取${verificationLabel}……`);
    const verification = String(
      await verificationGetter({ provider, email, sendResult, runtime, signal }),
    ).trim();
    if (!verification) throw new Error(`没有获取到${verificationLabel}。`);
    validateVerification(provider, verification, email);

    report(5, `正在当前浏览器中完成${verificationLabel}……`);
    await completeVerification(provider, runtime.cdp, verification, { email, profile, signal });

    report(6, "正在完成新用户引导……");
    await provider.completeOnboarding(runtime.cdp, {
      profile,
      signal,
      updateProgress: (message) => report(6, message),
    });

    report(7, "正在读取登录会话……");
    const session = await provider.extractSession(runtime.cdp, { signal });
    let authorizationResult = {};
    if (shouldAuthorize) {
      report(8, "正在完成 xAI OAuth 授权并生成 CLIProxy 认证文件……");
      authorizationResult = await provider.authorizeAfterRegistration(runtime.cdp, {
        email,
        projectRoot,
        authDir: authorization.authDir,
        proxyUrl: authorization.useProxy ? localProxyOf(runtime) : "",
        signal,
        updateProgress: (message) => report(8, message),
      });
    }
    const duration = elapsed(startedAt);
    const result = {
      provider: provider.id,
      email,
      ...provider.resultProfile(profile),
      durationMs: duration.ms,
      durationSeconds: duration.seconds,
      durationText: duration.text,
      profileDir: runtime.profileDir,
      debugPort: runtime.debugPort,
      localProxy: localProxyOf(runtime),
      upstreamProxy: proxyUrl ? maskProxy(proxyUrl) : "",
      ...session,
      ...authorizationResult,
      outputPath,
      completedAt: new Date().toISOString(),
    };
    await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");
    onEvent({ type: "completed", provider: provider.id, result });

    if (keepOpen) {
      retainRuntime = true;
      runtime.cdp.close();
    }
    return { status: "completed", keptOpen: retainRuntime, result, runtime: retainRuntime ? runtime : null };
  } catch (error) {
    if (runtime && keepOpenOnError && provider.isManualActionError(error)) {
      retainRuntime = true;
      runtime.cdp.close();
      const blocked = {
        provider: provider.id,
        email,
        reason: provider.summarizeError(error),
        profileDir: runtime.profileDir,
        debugPort: runtime.debugPort,
        localProxy: localProxyOf(runtime),
      };
      onEvent({ type: "blocked", provider: provider.id, blocked, error });
      return { status: "blocked", blocked, error, runtime };
    }
    onEvent({ type: "failed", provider: provider.id, email, error });
    throw error;
  } finally {
    if (signal && abortRuntime) signal.removeEventListener("abort", abortRuntime);
    if (runtime && !retainRuntime) await runtime.close();
  }
}

export function registrationResultSummary(result) {
  return {
    provider: result.provider,
    email: result.email,
    name: result.name,
    givenName: result.givenName,
    familyName: result.familyName,
    birthday: result.birthday,
    durationMs: result.durationMs,
    durationSeconds: result.durationSeconds,
    durationText: result.durationText,
    sessionKey: result.sessionKey,
    sessionKeyLC: result.sessionKeyLC,
    orgId: result.orgId,
    userId: result.userId,
    profileDir: result.profileDir,
    debugPort: result.debugPort,
    outputPath: result.outputPath,
    oauthAuthorized: result.oauthAuthorized,
    oauthEmail: result.oauthEmail,
    oauthExpired: result.oauthExpired,
    cliproxyAuthPath: result.cliproxyAuthPath,
    cliproxyAuthPermissionsRestricted: result.cliproxyAuthPermissionsRestricted,
  };
}

function assertProvider(provider) {
  const methods = [
    "resultProfile",
    "waitForLoginReady",
    "submitEmail",
    "sendVerification",
    "verificationWasSent",
    "completeOnboarding",
    "extractSession",
    "isManualActionError",
    "summarizeError",
  ];
  if (!provider?.id || !provider.displayName || !provider.startUrl) {
    throw new Error("注册服务适配器缺少基本信息。");
  }
  for (const method of methods) {
    if (typeof provider[method] !== "function") {
      throw new Error(`注册服务适配器缺少方法：${method}`);
    }
  }
  if (
    typeof provider.validateVerification !== "function" &&
    typeof provider.validateVerificationUrl !== "function"
  ) {
    throw new Error("注册服务适配器缺少方法：validateVerification");
  }
  if (
    typeof provider.completeVerification !== "function" &&
    typeof provider.openVerification !== "function"
  ) {
    throw new Error("注册服务适配器缺少方法：completeVerification");
  }
}

function validateVerification(provider, verification, email) {
  const validate = provider.validateVerification || provider.validateVerificationUrl;
  return validate.call(provider, verification, email);
}

function completeVerification(provider, cdp, verification, context) {
  const complete = provider.completeVerification || provider.openVerification;
  return complete.call(provider, cdp, verification, context);
}

function localProxyOf(runtime) {
  return runtime.bridge ? `http://${runtime.bridge.host}:${runtime.bridge.port}` : "";
}

function elapsed(startedAt) {
  const ms = Date.now() - startedAt;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return {
    ms,
    seconds: Number((ms / 1000).toFixed(2)),
    text: minutes > 0 ? `${minutes}分 ${seconds}秒` : `${seconds}秒`,
  };
}
