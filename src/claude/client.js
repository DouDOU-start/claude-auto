import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { openBrowserRuntime, wait } from "../core/browser-runtime.js";
import { BrowserHttpError, BrowserTransport } from "./browser-transport.js";
import { collectCompletion, parseSseStream } from "./sse.js";

const MAX_RETRIES = 5;

export class ClaudeWebClient {
  constructor({ runtime, transport, orgId, deviceId }) {
    this.runtime = runtime;
    this.transport = transport;
    this.orgId = orgId;
    this.deviceId = deviceId;
  }

  static async open({
    projectRoot,
    sessionKey,
    proxyUrl = "",
    browserPath = "",
    headless = false,
    profileDir = "",
    keepProfile = true,
  }) {
    if (!sessionKey) throw new Error("缺少 Claude sessionKey。");
    const runtime = await openBrowserRuntime({
      projectRoot,
      proxyUrl,
      chromePath: browserPath,
      profileDir:
        profileDir ||
        join(
          projectRoot,
          "profiles",
          `claude-client-${createHash("sha256").update(sessionKey).digest("hex").slice(0, 12)}`,
        ),
      headless,
      keepProfile,
      profilePrefix: "claude-api",
      startUrl: "about:blank",
    });

    try {
      const setCookie = await runtime.cdp.send("Network.setCookie", {
        name: "sessionKey",
        value: sessionKey,
        domain: ".claude.ai",
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 28,
        url: "https://claude.ai/",
      });
      if (!setCookie.success) throw new Error("浏览器未能写入 sessionKey。");
      await runtime.cdp.send("Network.setCookie", {
        name: "activitySessionId",
        value: randomUUID(),
        domain: ".claude.ai",
        path: "/",
        secure: true,
        httpOnly: false,
        sameSite: "Lax",
        url: "https://claude.ai/",
      });
      await runtime.cdp.send("Page.navigate", { url: "https://claude.ai/new" });
      await waitForPageReady(runtime.cdp, 30000);

      const transport = new BrowserTransport(runtime.cdp);
      const response = await transport.request("https://claude.ai/api/organizations", {
        headers: defaultHeaders(randomUUID()),
      });
      ensureStatus(response, [200]);
      const organizations = parseJson(response.body, "组织信息");
      const orgId = Array.isArray(organizations) ? organizations[0]?.uuid || "" : "";
      if (!orgId) throw new Error("当前 sessionKey 没有关联的 Claude 组织。");
      return new ClaudeWebClient({
        runtime,
        transport,
        orgId,
        deviceId: randomUUID(),
      });
    } catch (error) {
      await runtime.close();
      throw error;
    }
  }

  async close() {
    await this.runtime.close();
  }

  async createConversation(model) {
    return this.#requestJson(
      "POST",
      `${this.baseUrl()}/chat_conversations`,
      { name: "", model },
      [200, 201],
    );
  }

  async deleteConversation(conversationId) {
    const response = await this.transport.request(
      `${this.baseUrl()}/chat_conversations/${encodeURIComponent(conversationId)}`,
      {
        method: "DELETE",
        headers: this.headers(),
      },
    );
    ensureStatus(response, [200, 204]);
  }

  async renameConversation(conversationId, name) {
    return this.#requestJson(
      "PUT",
      `${this.baseUrl()}/chat_conversations/${encodeURIComponent(conversationId)}`,
      { name },
      [200, 204],
    );
  }

  async listConversations(limit = 20) {
    const response = await this.transport.request(
      `${this.baseUrl()}/chat_conversations?limit=${Number(limit) || 20}`,
      { headers: this.headers() },
    );
    ensureStatus(response, [200]);
    return parseJson(response.body, "会话列表");
  }

  async sendMessage(conversationId, request) {
    return collectCompletion(this.sendMessageStream(conversationId, request));
  }

  async *sendMessageStream(conversationId, request) {
    const payload = fillCompletionDefaults(request);
    const url = `${this.baseUrl()}/chat_conversations/${encodeURIComponent(conversationId)}/completion`;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let emitted = false;
      try {
        const chunks = this.transport.stream(url, {
          method: "POST",
          headers: {
            ...this.headers(),
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          body: JSON.stringify(payload),
        });
        for await (const event of parseSseStream(chunks)) {
          emitted = true;
          yield event;
        }
        return;
      } catch (error) {
        const retryable =
          !emitted &&
          attempt < MAX_RETRIES &&
          (error instanceof BrowserHttpError ? error.status === 429 : true);
        if (!retryable) throw error;
        const delay = (error instanceof BrowserHttpError ? 8000 : 5000) * (attempt + 1);
        console.warn(`请求失败，${Math.round(delay / 1000)} 秒后进行第 ${attempt + 1}/${MAX_RETRIES} 次重试。`);
        await wait(delay);
      }
    }
  }

  async uploadFile(fileName, data, mimeType = detectMime(fileName)) {
    const response = await this.transport.upload(
      `https://claude.ai/api/${this.orgId}/upload`,
      { fileName, mimeType, data },
    );
    ensureStatus(response, [200]);
    const parsed = parseJson(response.body, "文件上传结果");
    return {
      ...parsed,
      primaryColor: parsed.thumbnail_asset?.primary_color || "",
    };
  }

  baseUrl() {
    return `https://claude.ai/api/organizations/${this.orgId}`;
  }

  headers() {
    return defaultHeaders(this.deviceId);
  }

  async #requestJson(method, url, body, statuses) {
    const response = await this.transport.request(url, {
      method,
      headers: {
        ...this.headers(),
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    ensureStatus(response, statuses);
    if (!response.body) return {};
    return parseJson(response.body, "Claude 接口响应");
  }
}

export function fillCompletionDefaults(request = {}) {
  return {
    prompt: request.prompt || "",
    model: request.model || "claude-sonnet-5",
    effort: request.effort || "medium",
    thinking_mode: request.thinkingMode || request.thinking_mode || "auto",
    timezone: request.timezone || "Asia/Shanghai",
    locale: request.locale || "en-US",
    tools: request.tools ?? defaultTools(),
    attachments: request.attachments ?? [],
    files: request.files ?? [],
    sync_sources: request.syncSources ?? request.sync_sources ?? [],
    rendering_mode: request.renderMode || request.rendering_mode || "messages",
  };
}

export function defaultTools() {
  return [
    { type: "web_search_v0", name: "web_search" },
    { type: "artifacts_v0", name: "artifacts" },
    { type: "repl_v0", name: "repl" },
  ];
}

export function createBase64ImageAttachment(fileName, mimeType, base64Data) {
  return {
    file_name: fileName,
    file_type: mimeType,
    file_size: Math.floor(String(base64Data).length * 3 / 4),
    extracted_content: `data:${mimeType};base64,${base64Data}`,
  };
}

export function createUploadedImageAttachment(upload, extractedContent = "") {
  return {
    file_uuid: upload.file_uuid,
    file_name: upload.file_name,
    file_type: detectMime(upload.file_name),
    file_size: upload.size_bytes,
    extracted_content: extractedContent,
  };
}

function defaultHeaders(deviceId) {
  return {
    accept: "application/json",
    "anthropic-client-platform": "web_claude_ai",
    "anthropic-device-id": deviceId,
  };
}

function ensureStatus(response, expected) {
  if (expected.includes(response.status)) return;
  throw new BrowserHttpError(response.status, response.statusText, response.body);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label}不是有效 JSON。`);
  }
}

async function waitForPageReady(cdp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await cdp.evaluate(`({
      title: document.title,
      href: location.href,
      ready: document.readyState
    })`).catch(() => null);
    if (state?.href?.startsWith("chrome-error://")) {
      throw new Error("Chrome 无法加载 Claude，请检查代理地址和网络连通性。");
    }
    if (
      state?.ready === "complete" &&
      state.title &&
      !state.title.toLowerCase().includes("just a moment")
    ) {
      return;
    }
    await wait(500);
  }
  throw new Error("Claude 页面未能完成安全验证；请显示浏览器并手动完成 Cloudflare 验证后重试。");
}

function detectMime(fileName) {
  switch (extname(fileName).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}
