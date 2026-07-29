import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { parseArgs, isCliEntry } from "../core/cli.js";
import { projectRootFrom } from "../core/browser-runtime.js";
import { loadClaudeConfig } from "../claude/config.js";
import { ClaudeClientPool } from "../claude/client-pool.js";
import { FREE_MODELS, mapModel } from "../claude/models.js";
import {
  buildPrompt,
  estimateTokens,
  extractEffort,
  extractImageAttachments,
} from "../claude/anthropic-adapter.js";

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export function createApiServer({ pool, apiKey = "", maxBodyBytes = MAX_BODY_BYTES }) {
  const server = http.createServer(async (request, response) => {
    try {
      await handleApiRequest({ request, response, pool, apiKey, maxBodyBytes });
    } catch (error) {
      if (response.headersSent) {
        writeSse(response, "error", {
          type: "error",
          error: { type: "api_error", message: error.message },
        });
        response.end();
        return;
      }
      writeError(response, error.statusCode || 500, "api_error", error.message);
    }
  });
  server.requestTimeout = 5 * 60 * 1000;
  server.headersTimeout = 15 * 1000;
  server.keepAliveTimeout = 5 * 1000;
  return server;
}

export async function handleApiRequest({ request, response, pool, apiKey = "", maxBodyBytes = MAX_BODY_BYTES }) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    if (request.method !== "GET") return writeError(response, 405, "method_not_allowed", "只支持 GET。");
    return writeJson(response, 200, { status: "ok", accounts: pool.size });
  }

  if (!isAuthorized(request, apiKey)) {
    return writeError(response, 401, "authentication_error", "API 密钥无效。");
  }

  if (url.pathname === "/v1/models") {
    if (request.method !== "GET") return writeError(response, 405, "method_not_allowed", "只支持 GET。");
    return writeJson(response, 200, {
      data: FREE_MODELS.map((model) => ({
        id: model.id,
        display_name: model.name,
        type: "model",
        created_at: "2026-01-01T00:00:00Z",
      })),
      has_more: false,
    });
  }

  if (url.pathname === "/v1/messages") {
    if (request.method !== "POST") return writeError(response, 405, "method_not_allowed", "只支持 POST。");
    const body = await readJsonBody(request, maxBodyBytes);
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return writeError(response, 400, "invalid_request_error", "messages 不能为空。");
    }
    return handleMessages(response, pool.next(), body);
  }

  return writeError(response, 404, "not_found_error", "接口不存在。");
}

async function handleMessages(response, client, request) {
  const model = mapModel(request.model);
  const prompt = buildPrompt(request);
  const effort = extractEffort(request);
  const attachments = (request.messages || []).flatMap((message) =>
    extractImageAttachments(message.content),
  );
  const conversation = await client.createConversation(model);

  try {
    const completion = {
      prompt,
      model,
      effort,
      attachments,
    };
    if (request.stream) {
      return writeStreamingResponse(response, client, conversation.uuid, completion, model);
    }
    const result = await client.sendMessage(conversation.uuid, completion);
    const content = [];
    if (result.thinking) content.push({ type: "thinking", thinking: result.thinking });
    content.push({ type: "text", text: result.answer });
    for (const tool of result.toolCalls) {
      content.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input });
    }
    return writeJson(response, 200, {
      id: result.messageId || `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model,
      stop_reason: result.stopReason || "end_turn",
      content,
      usage: {
        input_tokens: estimateTokens(prompt),
        output_tokens: estimateTokens(result.answer + result.thinking),
      },
    });
  } finally {
    await client.deleteConversation(conversation.uuid).catch(() => {});
  }
}

async function writeStreamingResponse(response, client, conversationId, completion, model) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  writeSse(response, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      usage: { input_tokens: estimateTokens(completion.prompt), output_tokens: 0 },
    },
  });

  let blockIndex = 0;
  let blockOpen = false;
  let output = "";
  let thinking = "";
  let stopReason = "end_turn";
  let messageDeltaSent = false;

  try {
    for await (const event of client.sendMessageStream(conversationId, completion)) {
      if (response.destroyed) break;
      const data = event.data;
      if (!data || typeof data !== "object") continue;

      if (data.type === "content_block_start") {
        const block = normalizeContentBlock(data.content_block);
        if (!block) continue;
        writeSse(response, "content_block_start", {
          type: "content_block_start",
          index: blockIndex,
          content_block: block,
        });
        blockOpen = true;
        continue;
      }

      if (data.type === "content_block_delta") {
        const delta = normalizeDelta(data.delta);
        if (!delta) continue;
        if (!blockOpen) {
          const block = delta.type === "thinking_delta"
            ? { type: "thinking", thinking: "" }
            : { type: "text", text: "" };
          writeSse(response, "content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: block,
          });
          blockOpen = true;
        }
        if (delta.type === "text_delta") output += delta.text || "";
        if (delta.type === "thinking_delta") thinking += delta.thinking || "";
        writeSse(response, "content_block_delta", {
          type: "content_block_delta",
          index: blockIndex,
          delta,
        });
        continue;
      }

      if (data.type === "content_block_stop" && blockOpen) {
        writeSse(response, "content_block_stop", {
          type: "content_block_stop",
          index: blockIndex,
        });
        blockIndex += 1;
        blockOpen = false;
        continue;
      }

      if (data.type === "message_delta") {
        stopReason = data.delta?.stop_reason || stopReason;
        writeSse(response, "message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason },
          usage: { output_tokens: estimateTokens(output + thinking) },
        });
        messageDeltaSent = true;
      }
    }

    if (blockOpen) {
      writeSse(response, "content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });
    }
    if (!messageDeltaSent) {
      writeSse(response, "message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason },
        usage: { output_tokens: estimateTokens(output + thinking) },
      });
    }
    writeSse(response, "message_stop", { type: "message_stop" });
    response.end();
  } catch (error) {
    writeSse(response, "error", {
      type: "error",
      error: { type: "api_error", message: error.message },
    });
    response.end();
  }
}

function normalizeContentBlock(block) {
  if (block?.type === "thinking") return { type: "thinking", thinking: "" };
  if (block?.type === "text") return { type: "text", text: "" };
  if (block?.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id || `toolu_${randomUUID().replaceAll("-", "")}`,
      name: block.name || "unknown_tool",
      input: block.input || {},
    };
  }
  return null;
}

function normalizeDelta(delta) {
  if (delta?.type === "text_delta") return { type: "text_delta", text: delta.text || "" };
  if (delta?.type === "thinking_delta") {
    return { type: "thinking_delta", thinking: delta.thinking || "" };
  }
  if (delta?.type === "input_json_delta") {
    return { type: "input_json_delta", partial_json: delta.partial_json || "" };
  }
  return null;
}

async function readJsonBody(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      const error = new Error(`请求体不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB。`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    const wrapped = new Error(`请求 JSON 无效：${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function isAuthorized(request, apiKey) {
  if (!apiKey) return true;
  const xApiKey = request.headers["x-api-key"];
  const authorization = request.headers.authorization || "";
  return xApiKey === apiKey || authorization === `Bearer ${apiKey}`;
}

function writeJson(response, status, data) {
  if (response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function writeError(response, status, type, message) {
  writeJson(response, status, {
    type: "error",
    error: { type, message },
  });
}

function writeSse(response, event, data) {
  if (response.destroyed || response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  const projectRoot = projectRootFrom(import.meta.url);
  const config = loadClaudeConfig({
    projectRoot,
    overrides: {
      sessionKey: args.sessionKey,
      proxyUrl: args.proxy,
      browserPath: args.chrome,
      host: args.host,
      port: args.port,
      apiKey: args.apiKey,
      headless: args.showBrowser ? false : args.headless,
    },
  });
  if (config.sessionKeys.length === 0) {
    throw new Error("请通过环境变量或 config/app.local.json 配置 sessionKey。");
  }
  if (!isLoopback(config.host) && !config.apiKey) {
    throw new Error("监听非本机地址时必须配置 CLAUDE_API_KEY。");
  }

  const pool = await ClaudeClientPool.open({
    projectRoot,
    config,
    log: (message) => console.log(message),
  });
  const server = createApiServer({ pool, apiKey: config.apiKey });
  server.listen(config.port, config.host);
  await once(server, "listening");
  console.log(`API 服务已启动：http://${config.host}:${config.port}`);
  console.log(`可用账号数：${pool.size}`);

  const shutdown = async () => {
    server.close();
    await pool.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function isLoopback(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}

function printHelp() {
  console.log(`
用法：
  node src/commands/api-server.js [选项]

选项：
  --session-key <值>   Claude sessionKey，多个值可用逗号分隔。
  --proxy <地址>       带认证的上游代理地址。
  --chrome <路径>      Chrome 或 Chromium 可执行文件。
  --host <地址>        监听地址，默认 127.0.0.1。
  --port <端口>        监听端口，默认 8080。
  --api-key <值>       API 访问密钥。
  --headless           使用无头浏览器，可能需要先完成 Cloudflare 验证。
  --show-browser       强制显示浏览器窗口。
  --help               显示帮助。
`);
}

if (isCliEntry(import.meta.url)) {
  main().catch((error) => {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  });
}
