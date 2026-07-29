import { randomUUID } from "node:crypto";
import { wait } from "../core/browser-runtime.js";

export class BrowserHttpError extends Error {
  constructor(status, statusText, body = "") {
    super(`浏览器请求失败（${status} ${statusText}）：${body}`);
    this.name = "BrowserHttpError";
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class BrowserTransport {
  constructor(cdp) {
    this.cdp = cdp;
  }

  async request(url, options = {}) {
    const input = normalizeRequest(url, options);
    return this.cdp.evaluate(`
      (async () => {
        const input = ${JSON.stringify(input)};
        const response = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: input.body,
          credentials: "include",
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: await response.text(),
        };
      })()
    `);
  }

  async *stream(url, options = {}) {
    const id = randomUUID();
    const input = normalizeRequest(url, options);
    let completed = false;

    await this.cdp.evaluate(`
      (() => {
        const id = ${JSON.stringify(id)};
        const input = ${JSON.stringify(input)};
        globalThis.__claudeNodeStreams ||= new Map();
        const controller = new AbortController();
        const state = {
          controller,
          status: 0,
          statusText: "",
          headers: {},
          chunks: [],
          done: false,
          error: "",
          responseBody: "",
        };
        globalThis.__claudeNodeStreams.set(id, state);
        void (async () => {
          try {
            const response = await fetch(input.url, {
              method: input.method,
              headers: input.headers,
              body: input.body,
              credentials: "include",
              signal: controller.signal,
            });
            state.status = response.status;
            state.statusText = response.statusText;
            state.headers = Object.fromEntries(response.headers.entries());
            if (!response.ok) {
              state.responseBody = await response.text();
              return;
            }
            if (!response.body) return;
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              const text = decoder.decode(part.value, { stream: true });
              if (text) state.chunks.push(text);
            }
            const tail = decoder.decode();
            if (tail) state.chunks.push(tail);
          } catch (error) {
            if (error?.name !== "AbortError") {
              state.error = error?.message || String(error);
            }
          } finally {
            state.done = true;
          }
        })();
        return true;
      })()
    `);

    try {
      while (true) {
        const state = await this.#pollStream(id);
        for (const chunk of state.chunks || []) {
          yield chunk;
        }
        if (state.done) {
          completed = true;
          if (state.error) throw new Error(`浏览器流式请求失败：${state.error}`);
          if (state.status < 200 || state.status >= 300) {
            throw new BrowserHttpError(state.status, state.statusText, state.responseBody);
          }
          return;
        }
        await wait(25);
      }
    } finally {
      if (!completed) await this.#abortStream(id);
    }
  }

  async upload(url, { fileName, mimeType, data }) {
    const input = {
      url,
      fileName,
      mimeType,
      base64: Buffer.from(data).toString("base64"),
    };
    return this.cdp.evaluate(`
      (async () => {
        const input = ${JSON.stringify(input)};
        const binary = atob(input.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const form = new FormData();
        form.append("file", new Blob([bytes], { type: input.mimeType }), input.fileName);
        const response = await fetch(input.url, {
          method: "POST",
          body: form,
          credentials: "include",
        });
        return {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
          body: await response.text(),
        };
      })()
    `);
  }

  async #pollStream(id) {
    return this.cdp.evaluate(`
      (() => {
        const id = ${JSON.stringify(id)};
        const streams = globalThis.__claudeNodeStreams;
        const state = streams?.get(id);
        if (!state) return { done: true, error: "流式请求状态不存在", chunks: [] };
        const chunks = state.chunks.splice(0);
        const result = {
          status: state.status,
          statusText: state.statusText,
          headers: state.headers,
          chunks,
          done: state.done,
          error: state.error,
          responseBody: state.responseBody,
        };
        if (state.done) streams.delete(id);
        return result;
      })()
    `);
  }

  async #abortStream(id) {
    await this.cdp.evaluate(`
      (() => {
        const streams = globalThis.__claudeNodeStreams;
        const state = streams?.get(${JSON.stringify(id)});
        state?.controller?.abort();
        streams?.delete(${JSON.stringify(id)});
        return true;
      })()
    `).catch(() => {});
  }
}

function normalizeRequest(url, options) {
  return {
    url,
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body ?? undefined,
  };
}
