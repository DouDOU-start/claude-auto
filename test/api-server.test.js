import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { handleApiRequest } from "../src/commands/api-server.js";

test("API 服务校验密钥并保留系统提示词", async () => {
  const calls = [];
  const client = {
    async createConversation(model) {
      calls.push(["create", model]);
      return { uuid: "conv_1" };
    },
    async sendMessage(id, completion) {
      calls.push(["send", id, completion]);
      return {
        messageId: "msg_1",
        answer: "完成",
        thinking: "",
        stopReason: "end_turn",
        toolCalls: [],
      };
    },
    async deleteConversation(id) {
      calls.push(["delete", id]);
    },
  };
  const pool = { size: 1, next: () => client };
  const unauthorized = createResponse();
  await handleApiRequest({
    request: createRequest("GET", "/v1/models"),
    response: unauthorized,
    pool,
    apiKey: "secret",
  });
  assert.equal(unauthorized.status, 401);

  const response = createResponse();
  await handleApiRequest({
    request: createRequest("POST", "/v1/messages", {
      "x-api-key": "secret",
    }, {
      model: "claude-sonnet-5",
      system: "遵守系统要求",
      messages: [{ role: "user", content: "开始" }],
    }),
    response,
    pool,
    apiKey: "secret",
  });
  assert.equal(response.status, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.content[0].text, "完成");
  assert.match(calls.find((item) => item[0] === "send")[2].prompt, /遵守系统要求/);
  assert.deepEqual(calls.at(-1), ["delete", "conv_1"]);
});

test("API 服务能够输出 Anthropic SSE 流", async () => {
  let deleted = false;
  const client = {
    async createConversation() {
      return { uuid: "conv_stream" };
    },
    async *sendMessageStream() {
      yield {
        data: {
          type: "content_block_start",
          content_block: { type: "text", text: "" },
        },
      };
      yield {
        data: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "流式结果" },
        },
      };
      yield { data: { type: "content_block_stop" } };
      yield {
        data: {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
        },
      };
    },
    async deleteConversation() {
      deleted = true;
    },
  };
  const response = createResponse();
  await handleApiRequest({
    request: createRequest("POST", "/v1/messages", {}, {
      model: "claude-sonnet-5",
      stream: true,
      messages: [{ role: "user", content: "开始" }],
    }),
    response,
    pool: { size: 1, next: () => client },
  });
  assert.equal(response.status, 200);
  assert.match(response.body, /event: message_start/);
  assert.match(response.body, /流式结果/);
  assert.match(response.body, /event: message_stop/);
  assert.equal(deleted, true);
});

function createRequest(method, url, headers = {}, body = null) {
  const content = body === null ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(content);
  request.method = method;
  request.url = url;
  request.headers = headers;
  return request;
}

function createResponse() {
  return {
    status: 0,
    body: "",
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    write(chunk) {
      this.body += String(chunk);
      return true;
    },
    end(chunk = "") {
      this.body += String(chunk);
      this.writableEnded = true;
    },
  };
}
