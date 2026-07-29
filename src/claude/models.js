export const FREE_MODELS = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
];

export function mapModel(model) {
  if (FREE_MODELS.some((item) => item.id === model)) return model;
  if (String(model).includes("haiku")) return "claude-haiku-4-5-20251001";
  if (String(model).includes("sonnet-4")) return "claude-sonnet-4-6";
  return "claude-sonnet-5";
}
