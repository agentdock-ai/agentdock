import {
  cloneJsonValue,
  type ToolApprovalDecisionRecord,
} from "@agentdock-ai/contracts";
import type { PendingDecision } from "../langgraph/tool-approval-decisions.js";

export interface ApprovalDecisionRecord<
  TContext extends Record<string, unknown> = Record<string, unknown>,
> extends ToolApprovalDecisionRecord {
  context: TContext | undefined;
}
export type DecisionObserver<TContext extends Record<string, unknown>> = (
  record: ApprovalDecisionRecord<TContext>,
) => void | Promise<void>;

export function approvalDecisionRecord<
  TContext extends Record<string, unknown>,
>(
  { interrupt, action, decision }: PendingDecision,
  threadId: string,
  context: TContext | undefined,
): ApprovalDecisionRecord<TContext> {
  const result: ApprovalDecisionRecord<TContext> = {
    id: JSON.stringify([
      threadId,
      interrupt.interruptId,
      interrupt.occurrence ?? 0,
      action.toolCallId,
    ]),
    threadId,
    interruptId: interrupt.interruptId,
    toolCallId: action.toolCallId,
    tool: action.name,
    decision: decision.type,
    originalArgs: cloneJsonValue(action.input),
    context,
    at: new Date().toISOString(),
  };
  if (decision.type === "edit")
    result.editedArgs = cloneJsonValue(decision.editedAction.args);
  if (decision.message !== undefined) result.message = decision.message;
  return result;
}
