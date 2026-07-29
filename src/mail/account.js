export function parseMailAccountLine(line) {
  const [email, password, clientId, ...refreshParts] = String(line || "").trim().split("----");
  const refreshToken = refreshParts.join("----");
  if (!email || !password || !clientId || !refreshToken) {
    throw new Error("邮箱账号必须使用格式：email----password----client_id----refresh_token");
  }
  return { email, password, clientId, refreshToken };
}
