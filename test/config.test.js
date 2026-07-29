import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadClaudeConfig, splitSessionKeys } from "../src/claude/config.js";

test("会话密钥支持数组、逗号和换行，并自动去重", () => {
  assert.deepEqual(splitSessionKeys("a, b\na"), ["a", "b"]);
  assert.deepEqual(splitSessionKeys(["a", " b ", ""]), ["a", "b"]);
});

test("统一 JSON 配置能够加载全部运行参数", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "claude-config-test-"));
  try {
    await mkdir(join(projectRoot, "config"));
    await writeFile(
      join(projectRoot, "config", "app.local.json"),
      JSON.stringify({
        proxy: { url: "http://user:pass@example.com:8080" },
        browser: { path: "/browser", headless: false },
        claude: { sessionKeys: ["abc"], model: "model", effort: "high" },
        api: { host: "localhost", port: 9000, key: "key" },
      }),
      "utf8",
    );
    const config = loadClaudeConfig({ projectRoot, env: { DISPLAY: "1" } });
    assert.equal(config.proxyUrl, "http://user:pass@example.com:8080");
    assert.deepEqual(config.sessionKeys, ["abc"]);
    assert.equal(config.browserPath, "/browser");
    assert.equal(config.headless, false);
    assert.equal(config.model, "model");
    assert.equal(config.effort, "high");
    assert.equal(config.host, "localhost");
    assert.equal(config.port, 9000);
    assert.equal(config.apiKey, "key");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
