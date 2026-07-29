import test from "node:test";
import assert from "node:assert/strict";
import { parseSimpleYaml, splitSessionKeys } from "../src/claude/config.js";

test("会话密钥支持数组、逗号和换行，并自动去重", () => {
  assert.deepEqual(splitSessionKeys("a, b\na"), ["a", "b"]);
  assert.deepEqual(splitSessionKeys(["a", " b ", ""]), ["a", "b"]);
});

test("本地 YAML 配置能够读取带冒号的代理地址", () => {
  const config = parseSimpleYaml(`
    session_key: "abc"
    proxy: "http://user:pass@example.com:8080"
    effort: medium
  `);
  assert.equal(config.session_key, "abc");
  assert.equal(config.proxy, "http://user:pass@example.com:8080");
  assert.equal(config.effort, "medium");
});
