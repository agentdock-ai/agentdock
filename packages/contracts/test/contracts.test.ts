import { describe, expect, it } from "vitest";
import {
  AgentEventType,
  type AgentResumeRequest,
  type AgentRunRequest,
  type AgentEvent,
  type AgentSessionRecord,
  type ToolApprovalRequest,
  type ToolApprovalResponse,
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

  it("describes frontend run and approval requests", () => {
    const run: AgentRunRequest = {
      sessionId: "session-1",
      prompt: "Send the report.",
      context: { userId: "user-1" },
      maxSteps: 4,
    };
    const approval: ToolApprovalResponse = {
      approvalId: "approval-1",
      approved: true,
      toolCall: {
        toolCallId: "call-1",
        name: "send_report",
        input: { reportId: "report-1" },
      },
    };
    const resume: AgentResumeRequest = {
      sessionId: "session-1",
      runId: "run-1",
      context: { userId: "user-1" },
      approvals: [approval],
    };

    expect(JSON.parse(JSON.stringify({ run, resume }))).toEqual({
      run,
      resume,
    });
  });
});
