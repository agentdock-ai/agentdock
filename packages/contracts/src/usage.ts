import type { AgentUsage } from "./events.js";

export function sumUsage(usages: readonly AgentUsage[]): AgentUsage {
  const result: AgentUsage = {};
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
    "totalTokens",
    "costUsd",
  ] as const) {
    const values = usages.flatMap((usage) =>
      usage[key] === undefined ? [] : [usage[key]],
    );
    if (values.length > 0)
      result[key] = values.reduce((sum, value) => sum + value, 0);
  }
  return result;
}
