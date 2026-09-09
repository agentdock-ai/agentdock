export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** JSON Schema data supplied to a frontend or transport consumer. */
export type JsonSchema = boolean | { [key: string]: JsonValue };

export function cloneJsonValue(value: unknown, label = "value"): JsonValue {
  assertJsonValue(value, label);
  return clone(value);
}

export function cloneJsonObject(value: unknown, label = "object"): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return cloneJsonValue(value, label) as JsonObject;
}

export function assertJsonValue(
  value: unknown,
  label = "value",
): asserts value is JsonValue {
  validateJsonValue(value, label, new Set<object>());
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validateJsonValue(
  value: unknown,
  path: string,
  seen: Set<object>,
): void {
  if (value === null) return;
  if (typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} must contain only finite JSON numbers.`);
  }
  if (typeof value !== "object") {
    throw new Error(`${path} is not JSON-serializable.`);
  }
  if (seen.has(value))
    throw new Error(`${path} contains a circular reference.`);
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateJsonValue(item, `${path}[${index}]`, seen),
    );
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error(`${path} must contain only JSON objects and arrays.`);
    }
    for (const [key, item] of Object.entries(value)) {
      validateJsonValue(item, `${path}.${key}`, seen);
    }
  }

  seen.delete(value);
}

function clone(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) result[key] = clone(item);
  return result;
}
