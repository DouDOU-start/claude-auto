export async function findClaudePage(debugPort) {
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page =
    targets.find((target) => target.type === "page" && String(target.url || "").includes("claude.ai")) ||
    targets.find((target) => target.type === "page");
  if (!page?.webSocketDebuggerUrl) {
    throw new Error(`No page target found on DevTools port ${debugPort}.`);
  }
  return page;
}

export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.requests = new Map();
    this.ws = null;
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    this.ws.addEventListener("message", (message) => this.#onMessage(message));
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    await this.send("Network.enable", { maxPostDataSize: 1024 * 1024 });
    await this.send("Runtime.enable");
  }

  close() {
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

  interestingAuthRequests() {
    return [...this.requests.values()].filter((item) => {
      const url = item.request?.url || item.response?.url || "";
      return /send_magic_link|login_methods|auth/i.test(url);
    });
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
