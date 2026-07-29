import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  estimateTokens,
  extractImageAttachments,
} from "../src/claude/anthropic-adapter.js";

test("单条消息存在系统提示词时不会丢失系统内容", () => {
  const prompt = buildPrompt({
    system: "只用中文回答",
    messages: [{ role: "user", content: "你好" }],
  });
  assert.match(prompt, /只用中文回答/);
  assert.match(prompt, /你好/);
});

test("没有系统提示词的单条消息保持原始正文", () => {
  assert.equal(
    buildPrompt({ messages: [{ role: "user", content: "直接提问" }] }),
    "直接提问",
  );
});

test("图片内容块会转换为 Claude Web 附件", () => {
  const attachments = extractImageAttachments([
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "YWJj" },
    },
  ]);
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].file_type, "image/png");
  assert.match(attachments[0].extracted_content, /^data:image\/png;base64,/);
});

test("中英文混合文本可以得到非零令牌估算", () => {
  assert.ok(estimateTokens("你好 world") > 0);
});
