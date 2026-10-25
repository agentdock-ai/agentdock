import type { AgentInterrupt } from "@agentdock-ai/contracts";
import {
  InvalidApprovalDecisionError,
  toolApprovalDecisions,
} from "./tool-approval-decisions.js";

type ValidateResume = (
  value: unknown,
  pending: readonly AgentInterrupt[],
) => void;

/** Validate native HITL decisions, preserving tool names unless explicitly allowed. */
export function createToolApprovalResumeValidator(
  options: { allowToolRename?: boolean } = {},
): ValidateResume {
  const allowToolRename = options.allowToolRename === true;
  return (value, pending) => {
    for (const { action, decision } of toolApprovalDecisions(value, pending)) {
      if (
        action.allowedDecisions &&
        !action.allowedDecisions.includes(decision.type)
      )
        throw new InvalidApprovalDecisionError(
          `Decision ${decision.type} is not allowed for ${action.name}.`,
        );
      if (
        decision.type === "edit" &&
        !allowToolRename &&
        decision.editedAction.name !== action.name
      )
        throw new InvalidApprovalDecisionError(
          "An edit decision cannot change the tool name.",
        );
    }
  };
}
export const validateToolApprovalResume = createToolApprovalResumeValidator();
