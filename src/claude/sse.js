export async function* parseSseStream(chunks) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += String(chunk);
    while (true) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const event = decodeSseBlock(block);
      if (event) yield event;
    }
  }
  const event = decodeSseBlock(buffer);
  if (event) yield event;
}

export function decodeSseBlock(block) {
  if (!String(block || "").trim()) return null;
  let event = "message";
  const dataLines = [];
  for (const rawLine of String(block).split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const index = rawLine.indexOf(":");
    const field = index < 0 ? rawLine : rawLine.slice(0, index);
    let value = index < 0 ? "" : rawLine.slice(index + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const rawData = dataLines.join("\n");
  if (rawData === "[DONE]") return null;
  let data = rawData;
  try {
    data = JSON.parse(rawData);
  } catch {}
  return { event, data, rawData };
}

export async function collectCompletion(events) {
  const result = {
    model: "",
    messageId: "",
    requestId: "",
    answer: "",
    thinking: "",
    stopReason: "",
    toolCalls: [],
    rateLimit: null,
  };
  let currentTool = null;
  let toolInput = "";

  for await (const item of events) {
    const data = item?.data;
    if (!data || typeof data !== "object") continue;
    switch (data.type) {
      case "message_start":
        result.model = data.message?.model || "";
        result.messageId = data.message?.id || "";
        result.requestId = data.message?.request_id || "";
        break;
      case "content_block_start":
        if (data.content_block?.type === "tool_use") {
          currentTool = {
            id: data.content_block.id || "",
            name: data.content_block.name || "",
            input: null,
          };
          toolInput = "";
        }
        break;
      case "content_block_delta":
        if (data.delta?.type === "text_delta") result.answer += data.delta.text || "";
        if (data.delta?.type === "thinking_delta") result.thinking += data.delta.thinking || "";
        if (data.delta?.type === "input_json_delta") toolInput += data.delta.partial_json || "";
        break;
      case "content_block_stop":
        if (currentTool) {
          try {
            currentTool.input = JSON.parse(toolInput || "{}");
          } catch {
            currentTool.input = toolInput;
          }
          result.toolCalls.push(currentTool);
          currentTool = null;
          toolInput = "";
        }
        break;
      case "message_delta":
        result.stopReason = data.delta?.stop_reason || result.stopReason;
        break;
      case "message_limit":
        result.rateLimit = data.message_limit || null;
        break;
    }
  }
  return result;
}
