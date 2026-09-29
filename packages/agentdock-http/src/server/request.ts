import { isRecord } from "../utils/is-record.js";

export class InvalidRequestError extends Error {}

export async function readObjectBody(
  request: Request,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new InvalidRequestError("Request body must be valid JSON.");
  }
  if (!isRecord(value)) {
    throw new InvalidRequestError("Request body must be a JSON object.");
  }
  return value;
}

export function hasOnlyKey(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return (
    Object.keys(value).length === 1 &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}
