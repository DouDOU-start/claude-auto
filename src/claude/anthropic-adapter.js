import { createBase64ImageAttachment } from "./client.js";

export function buildPrompt(request) {
  const systemParts = extractSystemText(request.system);
  const messageParts = (request.messages || [])
    .map((message) => {
      const text = extractContentText(message.content);
      if (!text) return "";
      return `[${roleName(message.role)}]：${text}`;
    })
    .filter(Boolean);

  if (systemParts.length === 0 && messageParts.length === 1) {
    return extractContentText(request.messages[0].content);
  }

  return [
    ...systemParts.map((text) => `[系统]：${text}`),
    ...messageParts,
  ].join("\n\n");
}

export function extractImageAttachments(content) {
  if (!Array.isArray(content)) return [];
  const attachments = [];
  for (const block of content) {
    if (block?.type !== "image" || block.source?.type !== "base64") continue;
    const data = block.source.data || "";
    const mediaType = block.source.media_type || "";
    if (!data || !mediaType) continue;
    attachments.push(createBase64ImageAttachment("image.png", mediaType, data));
  }
  return attachments;
}

export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of String(text)) {
    if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(char)) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.ceil((cjk * 2) / 3) + Math.ceil(other / 4));
}

export function extractEffort(request, fallback = "medium") {
  return request.output_config?.effort || request.outputConfig?.effort || fallback;
}

function extractSystemText(system) {
  if (typeof system === "string") return system ? [system] : [];
  if (!Array.isArray(system)) return [];
  return system.map((block) => block?.text || "").filter(Boolean);
}

function extractContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text")
    .map((block) => block.text || "")
    .filter(Boolean)
    .join("\n");
}

function roleName(role) {
  if (role === "assistant") return "助手";
  if (role === "system") return "系统";
  return "用户";
}
