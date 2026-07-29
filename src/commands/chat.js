import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { isCliEntry, parseArgs } from "../core/cli.js";
import { projectRootFrom } from "../core/browser-runtime.js";
import { loadClaudeConfig } from "../claude/config.js";
import { ClaudeWebClient } from "../claude/client.js";
import { FREE_MODELS } from "../claude/models.js";
import { estimateTokens } from "../claude/anthropic-adapter.js";

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
      model: args.model,
      effort: args.effort,
      headless: args.showBrowser ? false : args.headless,
    },
  });
  if (config.sessionKeys.length === 0) {
    throw new Error("请通过环境变量或 config/claude.local.json 配置 sessionKey。");
  }

  console.log("正在初始化 Claude 浏览器会话……");
  const client = await ClaudeWebClient.open({
    projectRoot,
    sessionKey: config.sessionKeys[0],
    proxyUrl: config.proxyUrl,
    browserPath: config.browserPath,
    headless: config.headless,
  });
  const input = createInterface({ input: stdin, output: stdout });
  let conversation = null;

  try {
    let model = await selectModel(input, config.model);
    conversation = await client.createConversation(model.id);
    console.log(`已连接组织 ${client.orgId.slice(0, 8)}，模型：${model.name}`);
    console.log("命令：/new 新建会话，/model 切换模型，/quit 退出。\n");

    let lastQuota = 0;
    let totalInput = 0;
    let totalOutput = 0;
    while (true) {
      const prompt = (await input.question("你 > ")).trim();
      if (!prompt) continue;
      if (prompt === "/quit" || prompt === "/exit") break;
      if (prompt === "/new") {
        await client.deleteConversation(conversation.uuid).catch(() => {});
        conversation = await client.createConversation(model.id);
        console.log(`已创建新会话：${conversation.uuid.slice(0, 8)}\n`);
        continue;
      }
      if (prompt === "/model") {
        model = await selectModel(input, model.id);
        await client.deleteConversation(conversation.uuid).catch(() => {});
        conversation = await client.createConversation(model.id);
        console.log(`已切换到 ${model.name}。\n`);
        continue;
      }

      stdout.write("\nClaude > ");
      let outputText = "";
      let thinkingText = "";
      let messageModel = model.id;
      let requestId = "";
      for await (const event of client.sendMessageStream(conversation.uuid, {
        prompt,
        model: model.id,
        effort: config.effort,
      })) {
        const data = event.data;
        if (data?.type === "message_start") {
          messageModel = data.message?.model || messageModel;
          requestId = data.message?.request_id || "";
        }
        if (data?.type === "content_block_delta" && data.delta?.type === "text_delta") {
          const text = data.delta.text || "";
          stdout.write(text);
          outputText += text;
        }
        if (data?.type === "content_block_delta" && data.delta?.type === "thinking_delta") {
          thinkingText += data.delta.thinking || "";
        }
        if (data?.type === "message_limit" && data.message_limit?.windows?.["5h"]) {
          const window = data.message_limit.windows["5h"];
          const quota = Number(window.utilization || 0) * 100;
          const inputTokens = estimateTokens(prompt);
          const outputTokens = estimateTokens(outputText + thinkingText);
          totalInput += inputTokens;
          totalOutput += outputTokens;
          const resetAt = new Date(Number(window.resets_at || 0) * 1000).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          });
          stdout.write(
            `\n[模型：${messageModel}｜输入约 ${inputTokens}｜输出约 ${outputTokens}｜累计 ${totalInput}/${totalOutput}｜额度 ${quota.toFixed(0)}%（+${(quota - lastQuota).toFixed(1)}%）｜重置 ${resetAt}｜${requestId}]`,
          );
          lastQuota = quota;
        }
      }
      stdout.write("\n\n");
    }
  } finally {
    input.close();
    if (conversation) await client.deleteConversation(conversation.uuid).catch(() => {});
    await client.close();
  }
}

async function selectModel(input, currentModel) {
  console.log("\n可用模型：");
  FREE_MODELS.forEach((model, index) => {
    console.log(`  [${index + 1}] ${model.name}（${model.id}）`);
  });
  const defaultIndex = Math.max(0, FREE_MODELS.findIndex((model) => model.id === currentModel));
  const answer = (await input.question(`请选择模型 [${defaultIndex + 1}]：`)).trim();
  const selectedIndex = answer ? Number(answer) - 1 : defaultIndex;
  return FREE_MODELS[selectedIndex] || FREE_MODELS[defaultIndex];
}

function printHelp() {
  console.log(`
用法：
  node src/commands/chat.js [选项]

选项：
  --session-key <值>   Claude sessionKey。
  --proxy <地址>       带认证的上游代理地址。
  --chrome <路径>      Chrome 或 Chromium 可执行文件。
  --model <模型>       默认模型。
  --effort <强度>      推理强度：low、medium 或 high。
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
