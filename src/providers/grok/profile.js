import { randomBytes } from "node:crypto";

const FIRST_NAMES = [
  "Alex",
  "Taylor",
  "Jordan",
  "Morgan",
  "Casey",
  "Riley",
  "Avery",
  "Jamie",
  "Quinn",
  "Cameron",
];

const LAST_NAMES = [
  "Parker",
  "Reed",
  "Brooks",
  "Hayes",
  "Cole",
  "Bennett",
  "Foster",
  "Miller",
  "Stone",
  "Harper",
];

export function createGrokProfile({
  name = "",
  givenName = "",
  familyName = "",
  password = "",
} = {}) {
  const nameParts = String(name || "").trim().split(/\s+/).filter(Boolean);
  const actualGivenName = String(givenName || nameParts.shift() || randomItem(FIRST_NAMES)).trim();
  const actualFamilyName = String(
    familyName || nameParts.join(" ") || randomItem(LAST_NAMES),
  ).trim();
  const actualPassword = String(password || randomPassword());

  if (!actualGivenName) throw new Error("Grok 注册名字不能为空。");
  if (!actualFamilyName) throw new Error("Grok 注册姓氏不能为空。");
  if (actualPassword.length < 8) throw new Error("Grok 注册密码不能少于 8 个字符。");

  return {
    givenName: actualGivenName,
    familyName: actualFamilyName,
    displayName: `${actualGivenName} ${actualFamilyName}`,
    password: actualPassword,
  };
}

function randomPassword() {
  return `Gk!${randomBytes(12).toString("base64url")}`;
}

function randomItem(values) {
  return values[Math.floor(Math.random() * values.length)];
}
