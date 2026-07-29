import { throwIfAborted, waitWithSignal } from "../core/abort.js";

export async function pollVerificationMessage({
  tryRead,
  providerName,
  timeoutMs = 180000,
  intervalMs = 5000,
  log = () => {},
  signal,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    throwIfAborted(signal);
    try {
      const result = await tryRead();
      if (result.verificationUrl) return result;
      log(`暂未找到 ${providerName} 验证链接。模式=${result.mode || "未知"}，等待 ${intervalMs} 毫秒……`);
    } catch (error) {
      lastError = error;
      log(`邮件轮询失败：${error.message}`);
    }
    await waitWithSignal(intervalMs, signal);
  }

  throwIfAborted(signal);
  throw new Error(
    `超时前未找到 ${providerName} 验证链接。${lastError ? `最后错误：${lastError.message}` : ""}`,
  );
}
