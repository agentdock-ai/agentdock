import { describe, expect, it } from "vitest";
import {
  AgentEventType,
  type AgentEvent,
  type AgentSessionRecord,
  type ToolApprovalRequest,
} from "../src/index.js";

describe("AgentDock contracts", () => {
  it("defines a versioned, JSON-serializable event contract", () => {
    const event: AgentEvent = {
      version: 1,
      eventId: "event-1",
      runId: "run-1",
      sequence: 1,
      timestamp: new Date(0).toISOString(),
      type: AgentEventType.RunStarted,
      sessionId: "session-1",
    };

    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });

  it("keeps approval and session data independent of runtime classes", () => {
    const approval: ToolApprovalRequest = {
      approvalId: "approval-1",
      toolCall: {
        toolCallId: "call-1",
        name: "send_message",
        input: { message: "hello" },
      },
    };
    const session: AgentSessionRecord = {
      sessionId: "session-1",
      messages: [
        {
          role: "user",
          content: "hello",
        },
      ],
    };

    expect(JSON.stringify({ approval, session })).toBeTruthy();
  });
});
