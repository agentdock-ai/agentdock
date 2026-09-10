export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** JSON Schema data supplied to a frontend or transport consumer. */
export type JsonSchema = boolean | { [key: string]: JsonValue };

export class JsonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonValidationError";
  }
}

export function cloneJsonValue(value: unknown, label = "value"): JsonValue {
  assertJsonValue(value, label);
  return clone(value);
}

export function cloneJsonObject(value: unknown, label = "object"): JsonObject {
  if (!isJsonObject(value)) {
    throw new JsonValidationError(`${label} must be a JSON object.`);
  }
  return cloneJsonValue(value, label) as JsonObject;
}

export function cloneJsonSchema(value: unknown, label = "schema"): JsonSchema {
  if (typeof value === "boolean") return value;
  if (!isJsonObject(value)) {
    throw new JsonValidationError(
      `${label} must be a JSON Schema object or boolean.`,
    );
  }
  return cloneJsonValue(value, label) as JsonSchema;
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
    throw new JsonValidationError(
      `${path} must contain only finite JSON numbers.`,
    );
  }
  if (typeof value !== "object") {
    throw new JsonValidationError(`${path} is not JSON-serializable.`);
  }
  if (seen.has(value))
    throw new JsonValidationError(`${path} contains a circular reference.`);
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        throw new JsonValidationError(
          `${path}[${index}] is a sparse array entry.`,
        );
      }
      validateJsonValue(value[index], `${path}[${index}]`, seen);
    }
    for (const key of Object.keys(value)) {
      if (!isArrayIndexKey(key)) {
        throw new JsonValidationError(
          `${path}.${key} is not a JSON array entry.`,
        );
      }
    }
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      const symbol = symbols[0];
      throw new JsonValidationError(
        `${path}[${symbol.toString()}] is not JSON-serializable.`,
      );
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new JsonValidationError(
        `${path} must contain only JSON objects and arrays.`,
      );
    }
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) {
      const symbol = symbols[0];
      throw new JsonValidationError(
        `${path}[${symbol.toString()}] is not JSON-serializable.`,
      );
    }
    for (const [key, item] of Object.entries(value)) {
      validateJsonValue(item, `${path}.${key}`, seen);
    }
  }

  seen.delete(value);
}

function isArrayIndexKey(key: string): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < 2 ** 32 - 1 &&
    String(index) === key
  );
}

function clone(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(clone);
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) result[key] = clone(item);
  return result;
}
