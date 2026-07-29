import { claudeRegistrationProvider } from "./claude/registration.js";

const REGISTRATION_PROVIDERS = new Map([
  [claudeRegistrationProvider.id, claudeRegistrationProvider],
]);

export function getRegistrationProvider(id = "claude") {
  const providerId = String(id || "claude").toLowerCase();
  const provider = REGISTRATION_PROVIDERS.get(providerId);
  if (!provider) {
    throw new Error(
      `不支持的注册服务适配器：${providerId}。当前可用：${availableRegistrationProviders().join("、")}`,
    );
  }
  return provider;
}

export function availableRegistrationProviders() {
  return [...REGISTRATION_PROVIDERS.keys()];
}
