import {
  cloneJsonObject,
  type AgentInterrupt,
  type AgentToolApprovalInterruptAction,
  type JsonObject,
} from "@agentdock-ai/contracts";
import { isRecord } from "../utils/is-record.js";

export class InvalidApprovalDecisionError extends Error {
  readonly status = 400;
  readonly code = "invalid_approval_decision";
  constructor(message: string) {
    super(message);
    this.name = "InvalidApprovalDecisionError";
  }
}

type Decision =
  | { type: "approve" | "reject"; message?: string }
  | {
      type: "edit";
      editedAction: { name: string; args: JsonObject };
      message?: string;
    };
export interface PendingDecision {
  interrupt: Extract<AgentInterrupt, { kind: "tool-approval" }>;
  action: AgentToolApprovalInterruptAction;
  decision: Decision;
}

/** Native decision order matches the action order within each addressed interrupt. */
export function toolApprovalDecisions(
  value: unknown,
  pending: readonly AgentInterrupt[],
): PendingDecision[] {
  if (
    pending.length > 1 &&
    pending.some((item) => item.kind === "tool-approval") &&
    (!isRecord(value) ||
      !pending.some((item) =>
        Object.prototype.hasOwnProperty.call(value, item.interruptId),
      ))
  )
    throw new InvalidApprovalDecisionError(
      "Resume must target a pending interrupt ID when multiple approvals are waiting.",
    );
  const result: PendingDecision[] = [];
  for (const interrupt of pending) {
    if (interrupt.kind !== "tool-approval") continue;
    let response = value;
    if (
      isRecord(value) &&
      Object.prototype.hasOwnProperty.call(value, interrupt.interruptId)
    )
      response = value[interrupt.interruptId];
    else if (pending.length > 1) continue;
    if (
      !isRecord(response) ||
      !Array.isArray(response.decisions) ||
      response.decisions.length !== interrupt.actions.length
    )
      throw new InvalidApprovalDecisionError(
        "Resume must contain one decision for each pending approval action.",
      );
    for (const [index, raw] of response.decisions.entries()) {
      if (
        !isRecord(raw) ||
        (raw.type !== "approve" && raw.type !== "edit" && raw.type !== "reject")
      )
        throw new InvalidApprovalDecisionError(
          "Resume decision must be approve, edit, or reject.",
        );
      if (raw.message !== undefined && typeof raw.message !== "string")
        throw new InvalidApprovalDecisionError(
          "Resume decision.message must be a string.",
        );
      let decision: Decision;
      if (raw.type === "edit") {
        if (
          !isRecord(raw.editedAction) ||
          typeof raw.editedAction.name !== "string" ||
          !isRecord(raw.editedAction.args)
        )
          throw new InvalidApprovalDecisionError(
            "An edit decision must contain editedAction.name and editedAction.args.",
          );
        decision = {
          type: "edit",
          editedAction: {
            name: raw.editedAction.name,
            args: cloneJsonObject(raw.editedAction.args),
          },
        };
      } else decision = { type: raw.type };
      if (raw.message !== undefined) decision.message = raw.message;
      result.push({ interrupt, action: interrupt.actions[index], decision });
    }
  }
  return result;
}
