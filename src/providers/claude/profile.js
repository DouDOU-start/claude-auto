const DEFAULT_BIRTHDAY = "01/01/1995";
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
  "Drew",
  "Reese",
];
const LAST_NAMES = [
  "Morgan",
  "Parker",
  "Reed",
  "Brooks",
  "Hayes",
  "Cole",
  "Bennett",
  "Foster",
  "Miller",
  "Stone",
  "Wells",
  "Harper",
];

export function createClaudeProfile({ name = "", birthday = "" } = {}) {
  return {
    displayName: name || randomDisplayName(),
    birthday: birthday || DEFAULT_BIRTHDAY,
  };
}

export function parseBirthday(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error(`生日必须使用 MM/DD/YYYY 格式：${value}`);
  return {
    month: match[1].padStart(2, "0"),
    day: match[2].padStart(2, "0"),
    year: match[3],
  };
}

export function defaultClaudeBirthday() {
  return DEFAULT_BIRTHDAY;
}

function randomDisplayName() {
  const first = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return `${first} ${last}`;
}
