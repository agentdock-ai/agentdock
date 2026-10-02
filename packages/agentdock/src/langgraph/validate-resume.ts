import type { AgentInterrupt } from "@agentdock-ai/contracts";
import { isRecord } from "../utils/is-record.js";

/** Validate the opt-in HITL response envelope; middleware owns permissions. */
export function validateResume(
  value: unknown,
  pending: readonly AgentInterrupt[],
): void {
  if (
    pending.length > 1 &&
    pending.some((interrupt) => interrupt.kind === "tool-approval") &&
    (!isRecord(value) ||
      !pending.some((interrupt) =>
        Object.prototype.hasOwnProperty.call(value, interrupt.interruptId),
      ))
  )
    throw new Error(
      "Resume must target a pending interrupt ID when multiple approvals are waiting.",
    );
  for (const interrupt of pending) {
    if (interrupt.kind !== "tool-approval") continue;
    let response = value;
    if (
      isRecord(value) &&
      Object.prototype.hasOwnProperty.call(value, interrupt.interruptId)
    ) {
      response = value[interrupt.interruptId];
    } else if (pending.length > 1) continue;
    if (
      !isRecord(response) ||
      !Array.isArray(response.decisions) ||
      response.decisions.length !== interrupt.actions.length
    )
      throw new Error(
        "Resume must contain one decision for each pending approval action.",
      );
    for (const decision of response.decisions) {
      if (
        !isRecord(decision) ||
        typeof decision.type !== "string" ||
        !["approve", "edit", "reject"].includes(decision.type)
      )
        throw new Error("Resume decision must be approve, edit, or reject.");
      if (
        decision.type === "edit" &&
        (!isRecord(decision.editedAction) ||
          typeof decision.editedAction.name !== "string" ||
          !isRecord(decision.editedAction.args))
      )
        throw new Error(
          "An edit decision must contain editedAction.name and editedAction.args.",
        );
      if (
        decision.message !== undefined &&
        typeof decision.message !== "string"
      )
        throw new Error("Resume decision.message must be a string.");
    }
  }
}
