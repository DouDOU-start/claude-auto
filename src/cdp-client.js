export async function findPage(debugPort, { urlIncludes = "", timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  do {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
    const page = urlIncludes
      ? targets.find(
          (target) => target.type === "page" && String(target.url || "").includes(urlIncludes),
        )
      : targets.find((target) => target.type === "page");
    if (page?.webSocketDebuggerUrl) return page;
    if (Date.now() >= deadline) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  } while (true);

  const targetDescription = urlIncludes ? `匹配 ${JSON.stringify(urlIncludes)} 的` : "可用的";
  throw new Error(`DevTools 端口 ${debugPort} 上没有${targetDescription}页面目标。`);
}

export function findClaudePage(debugPort) {
  return findPage(debugPort, { urlIncludes: "claude.ai" });
}

export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.requests = new Map();
    this.listeners = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (message) => this.#onMessage(message));
    this.ws.addEventListener("close", () => {
      this.#rejectPending(new Error("CDP 连接已关闭。"));
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    await this.send("Network.enable", { maxPostDataSize: 1024 * 1024 });
    await this.send("Runtime.enable");
  }

  close(reason = new Error("CDP 连接已关闭。")) {
    this.#rejectPending(reason);
    this.ws?.close();
  }

  send(method, params = {}) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  }

  interestingRequests(matcher) {
    return [...this.requests.values()].filter((item) => {
      const url = item.request?.url || item.response?.url || "";
      if (typeof matcher === "function") return matcher(item, url);
      if (matcher instanceof RegExp) {
        matcher.lastIndex = 0;
        return matcher.test(url);
      }
      return matcher ? url.includes(String(matcher)) : true;
    });
  }

  interestingAuthRequests() {
    return this.interestingRequests(/send_magic_link|login_methods|auth/i);
  }

  on(method, listener) {
    if (typeof listener !== "function") throw new Error("CDP 事件监听器必须是函数。");
    const listeners = this.listeners.get(method) || new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  #onMessage(message) {
    const data = JSON.parse(message.data);
    if (data.id && this.pending.has(data.id)) {
      const pending = this.pending.get(data.id);
      this.pending.delete(data.id);
      if (data.error) {
        pending.reject(new Error(`${pending.method}: ${JSON.stringify(data.error)}`));
      } else {
        pending.resolve(data.result);
      }
      return;
    }

    const listeners = this.listeners.get(data.method);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data.params || {});
        } catch {}
      }
    }

    if (data.method === "Network.requestWillBeSent") {
      const req = data.params.request || {};
      this.requests.set(data.params.requestId, {
        requestId: data.params.requestId,
        request: {
          url: req.url,
          method: req.method,
          headers: req.headers,
          postData: req.postData,
          hasPostData: req.hasPostData,
        },
        initiator: data.params.initiator,
      });
      return;
    }

    if (data.method === "Network.responseReceived") {
      const item = this.requests.get(data.params.requestId) || { requestId: data.params.requestId };
      item.response = {
        url: data.params.response?.url,
        status: data.params.response?.status,
        statusText: data.params.response?.statusText,
        mimeType: data.params.response?.mimeType,
        headers: data.params.response?.headers,
      };
      this.requests.set(data.params.requestId, item);
    }
  }
}
