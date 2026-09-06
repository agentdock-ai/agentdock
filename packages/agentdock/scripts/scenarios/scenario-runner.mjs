import { stdout } from "node:process";
import { AgentEventType } from "../../dist/index.js";

export class ScenarioRunner {
  #textActive = false;

  constructor({
    agent,
    tools = [],
    sessionId = "scenario-session",
    context = {},
    approve,
    output = stdout,
    colors = output.isTTY,
  } = {}) {
    if (!agent)
      throw new Error("ScenarioRunner requires an AgentDock instance.");
    if (!sessionId.trim())
      throw new Error("ScenarioRunner requires a session ID.");

    this.agent = agent;
    this.sessionId = sessionId;
    this.context = context;
    this.approve = approve;
    this.output = output;
    this.colorsEnabled = Boolean(colors);

    for (const tool of tools) this.agent.registerTool(tool);
  }

  async run(prompt, options = {}) {
    this.line(`${this.paint("Scenario", "cyan")}: ${prompt}`);
    let result = await this.consume(
      await this.agent.stream(prompt, this.context, {
        ...options,
        sessionId: this.sessionId,
      }),
    );

    while (result.status === "waiting_for_approval") {
      const approvals = await this.resolveApprovals(result.approvalRequests);
      const { runId: _runId, ...resumeOptions } = options;
      const resumed = await this.consume(
        await this.agent.resumeStream(
          { runId: result.runId, approvals },
          this.context,
          { ...resumeOptions, sessionId: this.sessionId },
        ),
      );
      result = mergeRunResults(result, resumed);
    }

    this.printResult(result);
    return result;
  }

  async consume(session) {
    for await (const event of session.stream) this.render(event);
    if (this.#textActive) {
      this.line();
      this.#textActive = false;
    }
    return session.result;
  }

  async resolveApprovals(requests) {
    if (!this.approve) {
      throw new Error("Scenario requires an approve(request) handler.");
    }

    return Promise.all(
      requests.map(async (request) => {
        const approved = await this.approve(request);
        return {
          approvalId: request.approvalId,
          approved,
          ...(approved ? {} : { reason: "Denied by scenario." }),
        };
      }),
    );
  }

  render(event) {
    switch (event.type) {
      case AgentEventType.RunStarted:
        this.line(this.paint("Run started", "blue"));
        return;
      case AgentEventType.StreamStarted:
        this.line(this.paint("Stream started", "blue"));
        return;
      case AgentEventType.TextDelta:
        this.#textActive = true;
        this.write(this.paint(event.text, "green"));
        return;
      case AgentEventType.ToolCalled:
        this.line(
          `${this.paint("Tool call", "magenta")}: ${event.toolCall.name}`,
        );
        this.line(formatValue(event.toolCall.input));
        return;
      case AgentEventType.ToolResult:
        this.line(
          `${this.paint("Tool result", "green")}: ${formatValue(event.result.output)}`,
        );
        return;
      case AgentEventType.ToolError:
        this.line(`${this.paint("Tool error", "red")}: ${event.error.error}`);
        return;
      case AgentEventType.ApprovalRequired:
        this.line(
          `${this.paint("Approval requested", "yellow")}: ${event.approvals.length} tool call(s)`,
        );
        return;
      case AgentEventType.ApprovalResolved:
        this.line(
          `${this.paint("Approval resolved", "magenta")}: ${event.approvals.length} decision(s)`,
        );
        return;
      case AgentEventType.RunWaitingForApproval:
        this.line(this.paint("Run waiting for approval", "yellow"));
        return;
      case AgentEventType.RunCompleted:
        this.line(this.paint("Run completed", "green"));
        return;
      case AgentEventType.RunCancelled:
        this.line(
          `${this.paint("Run cancelled", "yellow")}: ${event.reason ?? "No reason provided"}`,
        );
        return;
      case AgentEventType.RunFailed:
        this.line(`${this.paint("Run failed", "red")}: ${event.error.message}`);
        return;
      default:
        throw new Error(`Unsupported AgentDock event: ${event.type}`);
    }
  }

  printResult(result) {
    this.line();
    this.line(this.paint("Final result", "cyan"));
    this.line(`Status: ${result.status}`);
    this.line(`Run ID: ${result.runId}`);
    this.line(`Session ID: ${result.sessionId}`);
    this.line(`Content: ${result.content || "(empty)"}`);
    this.line(`Tool calls: ${result.toolCalls.length}`);
    this.line(`Tool results: ${result.toolResults.length}`);
  }

  paint(value, foreground) {
    if (!this.colorsEnabled) return value;
    return `\u001b[${color[foreground]}m${value}\u001b[0m`;
  }

  write(value = "") {
    this.output.write(value);
  }

  line(value = "") {
    this.write(`${value}\n`);
  }
}

const color = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
};

function formatValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function mergeRunResults(previous, current) {
  return {
    ...current,
    toolCalls: mergeRecords(previous.toolCalls, current.toolCalls),
    toolResults: mergeRecords(previous.toolResults, current.toolResults),
    toolErrors: mergeRecords(previous.toolErrors, current.toolErrors),
  };
}

function mergeRecords(previous, current) {
  return [
    ...new Map(
      [...previous, ...current].map((record) => [record.toolCallId, record]),
    ).values(),
  ];
}

export function requireScenarioEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `Set ${name} before running scenarios. The key is never stored by AgentDock.`,
    );
  }
  return value;
}
