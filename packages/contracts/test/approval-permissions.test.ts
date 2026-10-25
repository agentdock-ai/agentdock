import { expect, it } from "vitest";
import { assertAgentInterrupt } from "../src/index.js";
const interrupt = (action: Record<string, unknown>) => ({
  kind: "tool-approval",
  interruptId: "i",
  prompt: "Review",
  actions: [
    { id: "call", name: "lookup", input: {}, toolCallId: "call", ...action },
  ],
});
it("accepts optional approval permissions and native descriptions", () => {
  expect(() =>
    assertAgentInterrupt(
      interrupt({
        allowedDecisions: ["approve", "edit", "reject"],
        description: "Review",
      }),
    ),
  ).not.toThrow();
  expect(() => assertAgentInterrupt(interrupt({}))).not.toThrow();
});
it.each([
  { allowedDecisions: false },
  { allowedDecisions: ["unknown"] },
  { allowedDecisions: [42] },
  { description: false },
])("rejects invalid approval metadata %j", (action) => {
  expect(() => assertAgentInterrupt(interrupt(action))).toThrow();
});
