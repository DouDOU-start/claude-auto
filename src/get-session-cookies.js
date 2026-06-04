import { CdpClient, findClaudePage } from "./cdp-client.js";

const debugPort = Number(process.argv[2]);
if (!debugPort) {
  throw new Error("usage: node src/get-session-cookies.js <debugPort>");
}

const page = await findClaudePage(debugPort);
const cdp = new CdpClient(page.webSocketDebuggerUrl);
await cdp.connect();
try {
  const state = await cdp.evaluate(`({
    href: location.href,
    title: document.title
  })`);
  const result = await cdp.send("Network.getCookies", {
    urls: [
      "https://claude.ai/",
      "https://claude.ai/chat",
      "https://console.anthropic.com/",
      "https://platform.claude.com/"
    ],
  });
  const cookies = result.cookies || [];
  const interesting = cookies.filter((cookie) =>
    /session|sk|key|auth|token/i.test(cookie.name)
  );
  console.log(JSON.stringify({ state, interesting, cookies }, null, 2));
} finally {
  cdp.close();
}
