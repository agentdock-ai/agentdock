export type JsonPrimitive = null | boolean | number | string;

export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** JSON Schema data supplied to a frontend or transport consumer. */
export type JsonSchema = { [key: string]: unknown };
