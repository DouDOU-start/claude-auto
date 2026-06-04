import net from "node:net";
import { Buffer } from "node:buffer";

const BUFFER_TIMEOUT_MS = 30000;

export function startProxyBridge({ listenHost = "127.0.0.1", listenPort = 0, upstream }) {
  if (!upstream?.host || !upstream?.port || !upstream?.username || !upstream?.password) {
    throw new Error("Proxy bridge requires upstream host, port, username, and password.");
  }

  const auth = Buffer.from(`${upstream.username}:${upstream.password}`, "utf8").toString("base64");
  const authHeader = `Proxy-Authorization: Basic ${auth}\r\n`;
  const server = net.createServer((client) => {
    client.setTimeout(BUFFER_TIMEOUT_MS);
    handleClient(client, upstream, authHeader).catch(() => client.destroy());
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        server,
        host: listenHost,
        port: typeof address === "object" && address ? address.port : listenPort,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function handleClient(client, upstream, authHeader) {
  const initial = await readHeaders(client);
  if (!initial) return;

  const firstLineEnd = initial.indexOf("\r\n");
  if (firstLineEnd === -1) return;

  const firstLine = initial.slice(0, firstLineEnd).toString("latin1");
  const [method, target, version] = firstLine.split(" ");
  if (!method || !target || !version) return;

  const remote = net.connect({ host: upstream.host, port: upstream.port });
  await onceConnect(remote);
  remote.setTimeout(BUFFER_TIMEOUT_MS);

  if (method.toUpperCase() === "CONNECT") {
    remote.write(`CONNECT ${target} ${version}\r\n${authHeader}\r\n`, "latin1");
    pipeBoth(client, remote);
    return;
  }

  const headerRest = initial.slice(firstLineEnd + 2).toString("latin1");
  const rewrittenTarget = rewriteHttpTarget(target);
  const cleanHeaders = headerRest
    .split(/\r\n/)
    .filter((line) => line && !/^proxy-authorization:/i.test(line))
    .join("\r\n");
  remote.write(`${method} ${rewrittenTarget} ${version}\r\n${authHeader}${cleanHeaders}\r\n\r\n`, "latin1");
  pipeBoth(client, remote);
}

function readHeaders(socket) {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onEnd);
      socket.off("timeout", onEnd);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      cleanup();
      const headers = buffer.slice(0, headerEnd + 4);
      const rest = buffer.slice(headerEnd + 4);
      if (rest.length) socket.unshift(rest);
      resolve(headers);
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onEnd);
    socket.once("timeout", onEnd);
  });
}

function rewriteHttpTarget(target) {
  try {
    const url = new URL(target);
    return `${url.pathname || "/"}${url.search || ""}`;
  } catch {
    return target;
  }
}

function onceConnect(socket) {
  return new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

function pipeBoth(a, b) {
  a.pipe(b);
  b.pipe(a);
  const destroyBoth = () => {
    a.destroy();
    b.destroy();
  };
  a.once("error", destroyBoth);
  b.once("error", destroyBoth);
  a.once("timeout", destroyBoth);
  b.once("timeout", destroyBoth);
}

export function parseProxyUrl(proxyUrl) {
  const parsed = new URL(proxyUrl);
  return {
    scheme: parsed.protocol.replace(/:$/, ""),
    host: parsed.hostname,
    port: Number(parsed.port || 80),
    username: decodeURIComponent(parsed.username || ""),
    password: decodeURIComponent(parsed.password || ""),
  };
}
