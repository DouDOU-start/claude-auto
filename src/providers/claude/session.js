export async function extractClaudeSession(cdp) {
  const result = await cdp.send("Network.getCookies", {
    urls: ["https://claude.ai/", "https://claude.ai/chat", "https://platform.claude.com/"],
  });
  const cookies = result.cookies || [];
  const interesting = cookies.filter((cookie) => /session|sk|key|auth|token|routing/i.test(cookie.name));
  return {
    sessionKey: cookies.find((cookie) => cookie.name === "sessionKey" && cookie.domain.includes("claude.ai"))?.value || "",
    sessionKeyLC: cookies.find((cookie) => cookie.name === "sessionKeyLC")?.value || "",
    routingHint: cookies.find((cookie) => cookie.name === "routingHint")?.value || "",
    orgId: await getOrganizationId(cdp),
    cookies: interesting,
  };
}

async function getOrganizationId(cdp) {
  try {
    const responseText = await cdp.evaluate(`fetch("/api/organizations").then((response) => response.text())`);
    const parsed = JSON.parse(responseText);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].uuid || "";
  } catch {}
  return "";
}
