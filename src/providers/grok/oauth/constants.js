export const XAI_OAUTH_DISCOVERY_URL =
  "https://auth.x.ai/.well-known/openid-configuration";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
export const XAI_DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_ACCOUNTS_ORIGIN = "https://accounts.x.ai";
export const XAI_DEVICE_FLOW_REFERRER = "grok-build";
export const XAI_DEVICE_FLOW_PLAN = "generic";
export const XAI_DEVICE_FLOW_RETRIES = 3;
export const XAI_DEVICE_FLOW_RETRY_GAP_MS = 1200;
export const DEFAULT_POLL_INTERVAL_MS = 5000;
export const MAX_POLL_DURATION_MS = 30 * 60 * 1000;
export const HTTP_TIMEOUT_MS = 30000;
