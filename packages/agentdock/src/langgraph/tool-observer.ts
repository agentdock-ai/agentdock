import {
  GraphCallbackHandler,
  type GraphInterruptEvent,
} from "@langchain/langgraph";
import type { StreamChunk } from "./parse-stream-chunk.js";

/** Observes native execution identities without wrapping or invoking tools. */
export class ToolObserver extends GraphCallbackHandler {
  name = "AgentdockToolObserver";
  awaitHandlers = true;
  observedTools = false;
  interruption?: GraphInterruptEvent;
  readonly rootTasks = new Set<string>();
  private rootStep = -Infinity;
  handleChainStart(
    _chain: unknown,
    _inputs: unknown,
    _runId: string,
    _runType?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): void {
    const ns = metadata?.langgraph_checkpoint_ns;
    const step = metadata?.langgraph_step;
    if (typeof ns !== "string" || ns.includes("|") || typeof step !== "number")
      return;
    if (step > this.rootStep) {
      this.rootTasks.clear();
      this.rootStep = step;
    }
    if (step === this.rootStep && ns.includes(":"))
      this.rootTasks.add(ns.slice(ns.indexOf(":") + 1));
  }
  handleInterrupt(event: GraphInterruptEvent): void {
    this.interruption = event;
  }
  private readonly calls = new Map<
    string,
    { namespace: string[]; id: string; name: string }
  >();
  private readonly chunks: StreamChunk[] = [];

  handleToolStart(
    _tool: unknown,
    input: string,
    runId: string,
    _parentRunId?: string,
    tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
    toolCallId?: string,
  ): void {
    if (!metadata || tags?.includes("langsmith:hidden")) return;
    this.observedTools = true;
    const namespace =
      typeof metadata.langgraph_checkpoint_ns === "string"
        ? metadata.langgraph_checkpoint_ns.split("|").filter(Boolean)
        : [];
    const call = {
      namespace,
      id: toolCallId || runId,
      name: runName ?? "tool",
    };
    this.calls.set(runId, call);
    this.chunks.push({
      mode: "tools",
      namespace,
      value: {
        event: "on_tool_start",
        toolCallId: call.id,
        name: call.name,
        input,
      },
    });
  }
  handleToolEvent(data: unknown, runId: string): void {
    this.push(runId, "on_tool_event", { data });
  }
  handleToolEnd(output: unknown, runId: string): void {
    this.push(runId, "on_tool_end", { output });
  }
  handleToolError(error: unknown, runId: string): void {
    this.push(runId, "on_tool_error", { error });
  }
  private push(
    runId: string,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const call = this.calls.get(runId);
    if (!call) return;
    this.chunks.push({
      mode: "tools",
      namespace: call.namespace,
      value: {
        event,
        toolCallId: call.id,
        name: call.name,
        ...payload,
      },
    });
    if (event !== "on_tool_event") this.calls.delete(runId);
  }
  drain(): StreamChunk[] {
    return this.chunks.splice(0);
  }
}
