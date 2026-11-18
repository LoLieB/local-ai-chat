export function makeStressItems(count: number, prefix = "item") {
  return Array.from({ length: Math.max(0, count) }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    title: `${prefix} ${index + 1} ${"x".repeat(index % 5 === 0 ? 24 : 0)}`
  }));
}

export function makeLongMessage(length = 20_000) {
  return "message-".repeat(Math.max(1, Math.ceil(length / 8))).slice(0, length);
}
