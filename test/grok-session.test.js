import test from "node:test";
import assert from "node:assert/strict";
import { extractGrokSession } from "../src/providers/grok/session.js";

test("Grok 会话优先读取 x.ai 域下的 SSO Cookie", async () => {
  const session = await extractGrokSession({
    async send(method) {
      assert.equal(method, "Network.getCookies");
      return {
        cookies: [
          { name: "sso", value: "旧站登录态", domain: ".grok.com" },
          { name: "sso", value: "xAI 登录态", domain: ".x.ai" },
          { name: "sso-rw", value: "旧站读写登录态", domain: ".grok.com" },
          { name: "sso-rw", value: "xAI 读写登录态", domain: ".x.ai" },
        ],
      };
    },
  });

  assert.equal(session.sessionToken, "xAI 登录态");
  assert.equal(session.sessionTokenRw, "xAI 读写登录态");
});
