import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { maskProxy } from "../config.js";
import { openBrowserRuntime, timestamp } from "./browser-runtime.js";
import { throwIfAborted } from "./abort.js";

const TOTAL_STEPS = 7;

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
  getVerificationUrl,
  onEvent = () => {},
  signal,
  openRuntime = openBrowserRuntime,
}) {
  assertProvider(provider);
  if (!email) throw new Error("缺少注册邮箱。");
  if (typeof getVerificationUrl !== "function") throw new Error("缺少验证链接获取方法。");

  const startedAt = Date.now();
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
    onEvent({ type: "progress", provider: provider.id, step, total: TOTAL_STEPS, message });
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

    report(3, "正在发送邮箱验证链接……");
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

    report(4, "正在获取邮箱验证链接……");
    const verificationUrl = String(
      await getVerificationUrl({ provider, email, sendResult, runtime, signal }),
    ).trim();
    if (!verificationUrl) throw new Error("没有获取到邮箱验证链接。");
    provider.validateVerificationUrl(verificationUrl, email);

    report(5, "正在当前浏览器中打开验证链接……");
    await provider.openVerification(runtime.cdp, verificationUrl, { signal });

    report(6, "正在完成新用户引导……");
    await provider.completeOnboarding(runtime.cdp, { profile, signal });

    report(7, "正在读取登录会话……");
    const session = await provider.extractSession(runtime.cdp, { signal });
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
    birthday: result.birthday,
    durationMs: result.durationMs,
    durationSeconds: result.durationSeconds,
    durationText: result.durationText,
    sessionKey: result.sessionKey,
    sessionKeyLC: result.sessionKeyLC,
    orgId: result.orgId,
    profileDir: result.profileDir,
    debugPort: result.debugPort,
    outputPath: result.outputPath,
  };
}

function assertProvider(provider) {
  const methods = [
    "resultProfile",
    "waitForLoginReady",
    "submitEmail",
    "sendVerification",
    "verificationWasSent",
    "validateVerificationUrl",
    "openVerification",
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
