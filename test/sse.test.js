import test from "node:test";
import assert from "node:assert/strict";
import { collectCompletion, parseSseStream } from "../src/claude/sse.js";

test("SSE 解析支持跨分块事件", async () => {
  async function* chunks() {
    yield 'event: content_block_delta\ndata: {"type":"content_';
    yield 'block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n';
  }
  const events = [];
  for await (const event of parseSseStream(chunks())) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "content_block_delta");
  assert.equal(events[0].data.delta.text, "你好");
});

test("完整响应收集器能够汇总正文、思考和停止原因", async () => {
  async function* events() {
    yield { data: { type: "message_start", message: { id: "msg_1", model: "m" } } };
    yield { data: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "想" } } };
    yield { data: { type: "content_block_delta", delta: { type: "text_delta", text: "答" } } };
    yield { data: { type: "message_delta", delta: { stop_reason: "end_turn" } } };
  }
  const result = await collectCompletion(events());
  assert.equal(result.messageId, "msg_1");
  assert.equal(result.thinking, "想");
  assert.equal(result.answer, "答");
  assert.equal(result.stopReason, "end_turn");
});
