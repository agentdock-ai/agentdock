import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const color = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m",
};

export class ScenarioRunner {
  #readline;
  #textActive = false;

  constructor({ agent, sessionId, context = {}, input = stdin, output = stdout }) {
    if (!agent) throw new Error("ScenarioRunner requires an agent.");
    if (!sessionId?.trim()) {
      throw new Error("ScenarioRunner requires a session ID.");
    }

    this.agent = agent;
    this.sessionId = sessionId;
    this.context = context;
    this.input = input;
    this.output = output;
    this.colorsEnabled = process.env.NO_COLOR === undefined &&
      (output.isTTY || process.env.FORCE_COLOR !== undefined);
  }

  async run(prompt, options = {}) {
    this.line(`${this.paint("Scenario", "bold", "cyan")}: ${prompt}`);

    try {
      let result = await this.consume(
        await this.agent.stream(prompt, this.context, {
          ...options,
          sessionId: this.sessionId,
        }),
      );
      let approvalRounds = 0;

      while (result.status === "waiting_for_approval") {
        approvalRounds += 1;
        if (approvalRounds > 10) {
          throw new Error("Scenario exceeded 10 approval rounds.");
        }

        const approvals = await this.requestApprovals(result.approvalRequests);
        result = await this.consume(
          await this.agent.resumeStream(
            { runId: result.runId, approvals },
            this.context,
            { ...options, sessionId: this.sessionId },
          ),
        );
      }

      this.printResult(result);
      return result;
    } finally {
      this.#readline?.close();
      this.#readline = undefined;
    }
  }

  async consume(session) {
    for await (const event of session.stream) {
      this.render(event);
    }

    if (this.#textActive) {
      this.line();
      this.#textActive = false;
    }

    return session.result;
  }

  async requestApprovals(requests) {
    if (!this.#readline) {
      this.#readline = createInterface({ input: this.input, output: this.output });
    }

    this.line(this.paint("Approval required", "bold", "yellow"));
    const approvals = [];

    for (const request of requests) {
      const answer = await this.#readline.question(
        `${this.paint(request.toolCall.name, "cyan")}? [y/n] `,
      );
      const approved = /^(y|yes)$/i.test(answer.trim());

      approvals.push({
        approvalId: request.approvalId,
        approved,
        ...(approved ? {} : { reason: "Denied manually" }),
      });
    }

    return approvals;
  }

  render(event) {
    switch (event.type) {
      case "run.started":
        this.line(this.paint("Run started", "bold", "blue"));
        return;
      case "step.started":
        this.line(`${this.paint("Step", "bold", "blue")} ${event.step}`);
        return;
      case "text.started":
        this.#textActive = true;
        return;
      case "text.delta":
        this.write(this.paint(event.text, "green"));
        return;
      case "text.completed":
        this.line();
        this.#textActive = false;
        return;
      case "reasoning.delta":
        this.write(this.paint(event.text, "dim"));
        return;
      case "reasoning.completed":
        this.line();
        return;
      case "tool.called":
        this.printToolCall(event.toolCall);
        return;
      case "tool.result":
        this.line(`${this.paint("Tool result", "bold", "green")} ${formatValue(event.result.output)}`);
        return;
      case "tool.error":
        this.line(`${this.paint("Tool error", "bold", "red")} ${event.error.message}`);
        return;
      case "tool.output.denied":
        this.line(`${this.paint("Tool denied", "bold", "yellow")} ${event.toolCall.name}`);
        return;
      case "approval.required":
        this.line(`${this.paint("Approval requested", "bold", "yellow")} ${event.approvals.length} tool call(s)`);
        return;
      case "approval.resolved":
        this.line(`${this.paint("Approval resolved", "bold", "magenta")} ${event.approvals.length} decision(s)`);
        return;
      case "stream.finished":
        this.line(`${this.paint("Stream finished", "bold", "blue")} ${event.finishReason}`);
        return;
      case "stream.aborted":
        this.line(`${this.paint("Stream aborted", "bold", "yellow")} ${event.reason ?? "No reason provided"}`);
        return;
      case "stream.error":
        this.line(`${this.paint("Stream error", "bold", "red")} ${event.error.message}`);
        return;
      case "run.completed":
        this.line(this.paint("Run completed", "bold", "green"));
        return;
      case "run.cancelled":
        this.line(`${this.paint("Run cancelled", "bold", "yellow")} ${event.reason ?? "No reason provided"}`);
        return;
      case "run.failed":
        this.line(`${this.paint("Run failed", "bold", "red")} ${event.error.message}`);
        return;
      default:
        return;
    }
  }

  printToolCall(toolCall) {
    this.line(`${this.paint("Tool call", "bold", "magenta")} ${this.paint(toolCall.name, "cyan")}`);
    this.line(this.paint(formatValue(toolCall.input), "dim"));
  }

  printResult(result) {
    this.line();
    this.line(this.paint("Final result", "bold", "cyan"));
    this.line(`${this.paint("Status", "bold")} ${result.status}`);
    this.line(`${this.paint("Run ID", "bold")} ${result.runId}`);
    this.line(`${this.paint("Session ID", "bold")} ${result.sessionId}`);
    this.line(`${this.paint("Content", "bold")} ${result.content || "(empty)"}`);
    this.line(`${this.paint("Tool calls", "bold")} ${result.toolCalls.length}`);
    this.line(`${this.paint("Tool results", "bold")} ${result.toolResults.length}`);
  }

  paint(value, style, foreground) {
    if (!this.colorsEnabled) return value;
    return `${color[style] ?? ""}${color[foreground] ?? ""}${value}${color.reset}`;
  }

  write(value = "") {
    this.output.write(value);
  }

  line(value = "") {
    this.write(`${value}\n`);
  }
}

function formatValue(value) {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
