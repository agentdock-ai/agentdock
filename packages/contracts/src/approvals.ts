import { cloneJsonValue, type JsonValue } from "./json.js";

/** Durable decision intent. Hosts upsert by id when retrying audit writes. */
export interface ToolApprovalDecisionRecord {
  id: string;
  threadId: string;
  interruptId: string;
  toolCallId: string;
  tool: string;
  decision: "approve" | "edit" | "reject";
  originalArgs: JsonValue;
  editedArgs?: JsonValue;
  message?: string;
  at: string;
}

export function cloneToolApprovalDecisionRecord(
  value: unknown,
): ToolApprovalDecisionRecord {
  const record = cloneJsonValue(value, "Approval decision record");
  if (!record || typeof record !== "object" || Array.isArray(record))
    throw new Error("Approval decision record must be an object.");
  for (const key of [
    "id",
    "threadId",
    "interruptId",
    "toolCallId",
    "tool",
    "at",
  ])
    if (typeof record[key] !== "string" || !record[key])
      throw new Error(
        `Approval decision record.${key} must be a non-empty string.`,
      );
  if (
    record.decision !== "approve" &&
    record.decision !== "edit" &&
    record.decision !== "reject"
  )
    throw new Error("Approval decision record.decision is invalid.");
  if (!Number.isFinite(Date.parse(String(record.at))))
    throw new Error("Approval decision record.at must be a timestamp.");
  if (record.message !== undefined && typeof record.message !== "string")
    throw new Error("Approval decision record.message must be a string.");
  if (record.originalArgs === undefined)
    throw new Error("Approval decision record.originalArgs is required.");
  if (record.decision === "edit" && record.editedArgs === undefined)
    throw new Error(
      "Approval decision record.editedArgs is required for an edit.",
    );
  const result: ToolApprovalDecisionRecord = {
    id: String(record.id),
    threadId: String(record.threadId),
    interruptId: String(record.interruptId),
    toolCallId: String(record.toolCallId),
    tool: String(record.tool),
    at: String(record.at),
    decision: record.decision,
    originalArgs: record.originalArgs,
  };
  if (record.editedArgs !== undefined) result.editedArgs = record.editedArgs;
  if (record.message !== undefined) result.message = record.message;
  return result;
}
