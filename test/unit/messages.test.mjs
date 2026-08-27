import assert from "node:assert/strict";
import { test } from "vitest";
import {
  buildHistory,
} from "../../src/agent/runtime/run-context.js";
import {
  normalizeToolCalls,
  normalizeToolResults,
  toInternalMessages,
  toModelInput,
} from "../../src/agent/runtime/messages.js";

test("buildHistory appends the prompt and adds a system prompt once", () => {
  const previousMessages = [
    { role: "user", content: "What is the weather in Lahore?" },
    { role: "assistant", content: "I can check that." },
  ];

  const history = buildHistory("Will it rain tomorrow?", {
    messages: previousMessages,
    systemPrompt: "You are a weather assistant.",
  });

  assert.deepEqual(history, [
    { role: "system", content: "You are a weather assistant." },
    ...previousMessages,
    { role: "user", content: "Will it rain tomorrow?" },
  ]);
  assert.deepEqual(previousMessages, [
    { role: "user", content: "What is the weather in Lahore?" },
    { role: "assistant", content: "I can check that." },
  ]);
});

test("buildHistory does not duplicate an active system message", () => {
  const history = buildHistory("Continue.", {
    messages: [{ role: "system", content: "Existing instructions." }],
    systemPrompt: "New instructions.",
  });

  assert.deepEqual(history, [
    { role: "system", content: "Existing instructions." },
    { role: "user", content: "Continue." },
  ]);
});

test("toModelInput separates active system instructions from conversation", () => {
  const input = toModelInput([
    { role: "system", content: "Be precise." },
    { role: "user", content: "Find the report." },
    {
      role: "assistant",
      content: "I will search.",
      toolCalls: [{ toolCallId: "call-search", name: "search", input: { q: "report" } }],
      approvalRequests: [{
        approvalId: "approval-search",
        toolCall: { toolCallId: "call-search", name: "search", input: { q: "report" } },
      }],
    },
    {
      role: "tool",
      content: "",
      toolResults: [{
        toolCallId: "call-search",
        name: "search",
        input: { q: "report" },
        output: { id: "report-1" },
      }],
      approvalResponses: [{
        approvalId: "approval-search",
        toolCall: { toolCallId: "call-search", name: "search", input: { q: "report" } },
        approved: true,
      }],
    },
  ]);

  assert.equal(input.instructions, "Be precise.");
  assert.deepEqual(input.messages, [
    { role: "user", content: "Find the report." },
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will search." },
        { type: "tool-call", toolCallId: "call-search", toolName: "search", input: { q: "report" } },
        { type: "tool-approval-request", approvalId: "approval-search", toolCallId: "call-search" },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-search", toolName: "search", output: { id: "report-1" } },
        { type: "tool-approval-response", approvalId: "approval-search", approved: true },
      ],
    },
  ]);
});

test("toInternalMessages restores assistant calls, approvals, and tool results", () => {
  const messages = toInternalMessages([
    {
      role: "assistant",
      content: [
        { type: "text", text: "I found it." },
        { type: "tool-call", toolCallId: "call-search", toolName: "search", input: { q: "report" } },
        { type: "tool-approval-request", approvalId: "approval-search", toolCallId: "call-search" },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call-search", toolName: "search", output: { id: "report-1" } },
      ],
    },
  ]);

  assert.deepEqual(messages, [
    {
      role: "assistant",
      content: "I found it.",
      toolCalls: [{ toolCallId: "call-search", name: "search", input: { q: "report" } }],
      approvalRequests: [{
        approvalId: "approval-search",
        toolCall: { toolCallId: "call-search", name: "search", input: { q: "report" } },
      }],
    },
    {
      role: "tool",
      content: JSON.stringify([{
        toolCallId: "call-search",
        name: "search",
        input: undefined,
        output: { id: "report-1" },
      }]),
      toolResults: [{
        toolCallId: "call-search",
        name: "search",
        input: undefined,
        output: { id: "report-1" },
      }],
    },
  ]);
});

test("tool calls and results are normalized to AgentDock records", () => {
  assert.deepEqual(
    normalizeToolCalls([
      { toolCallId: "call-search", toolName: "search", input: { q: "report" } },
    ]),
    [{ toolCallId: "call-search", name: "search", input: { q: "report" } }],
  );
  assert.deepEqual(
    normalizeToolResults([
      {
        toolCallId: "call-search",
        toolName: "search",
        input: { q: "report" },
        output: { id: "report-1" },
      },
    ]),
    [{
      toolCallId: "call-search",
      name: "search",
      input: { q: "report" },
      output: { id: "report-1" },
    }],
  );
});
