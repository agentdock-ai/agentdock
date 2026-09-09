import type { Tool } from "../agent/types.js";
import {
  cloneJsonObject,
  isJsonObject,
  type JsonObject,
  type ToolSchema,
} from "@agentdock/contracts";

export type { ToolSchema } from "@agentdock/contracts";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    const snapshot = normalizeTool(tool);
    if (this.tools.has(snapshot.name)) {
      throw new Error(`Tool already registered: ${snapshot.name}`);
    }

    this.tools.set(snapshot.name, snapshot);
  }

  get(name: string): Tool | undefined {
    const tool = this.tools.get(name);
    return tool ? cloneTool(tool) : undefined;
  }

  list(): Tool[] {
    return Array.from(this.tools.values(), cloneTool);
  }

  schemas(): ToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      requiresApproval: tool.requiresApproval ?? false,
    }));
  }

  clear(): void {
    this.tools.clear();
  }
}

/** Validates model arguments against the supported JSON Schema subset. */
export function validateToolInput(
  parameters: JsonObject,
  input: JsonObject,
  toolName: string,
): JsonObject {
  validateInputNode(parameters, input, "$", toolName);
  return input;
}

const JSON_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

function normalizeTool(tool: unknown): Tool {
  if (!isRecord(tool)) throw new Error("Tool must be an object.");

  const name = requireNonEmptyString(tool.name, "Tool name");
  if (name !== name.trim()) {
    throw new Error(
      `Tool name must not have leading or trailing whitespace: ${name}`,
    );
  }
  const description = requireNonEmptyString(
    tool.description,
    `Tool description: ${name}`,
  );
  if (!isToolExecute(tool.execute)) {
    throw new Error(`Tool execute must be a function: ${name}`);
  }
  if (tool.authorize !== undefined && !isToolAuthorize(tool.authorize)) {
    throw new Error(`Tool authorize must be a function: ${name}`);
  }
  if (
    tool.requiresApproval !== undefined &&
    typeof tool.requiresApproval !== "boolean"
  ) {
    throw new Error(`Tool requiresApproval must be a boolean: ${name}`);
  }

  validateParameters(tool.parameters, name);
  return {
    name,
    description,
    execute: tool.execute,
    parameters: cloneParameters(tool.parameters, name),
    ...(tool.authorize ? { authorize: tool.authorize } : {}),
    ...(tool.requiresApproval !== undefined
      ? { requiresApproval: tool.requiresApproval }
      : {}),
  };
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function validateParameters(
  parameters: unknown,
  name: string,
): asserts parameters is JsonObject {
  if (!isJsonObject(parameters)) {
    throw new Error(`Tool parameters must be a JSON schema object: ${name}`);
  }
  if (parameters.type !== "object") {
    throw new Error(`Tool parameters must have an object root type: ${name}`);
  }

  validateSchemaNode(parameters, name, "$", false);
}

function validateSchemaNode(
  value: unknown,
  toolName: string,
  path: string,
  allowBoolean: boolean,
): void {
  if (allowBoolean && typeof value === "boolean") return;
  if (!isRecord(value)) {
    throw new Error(
      `Tool parameters contain an invalid JSON schema at ${path}: ${toolName}`,
    );
  }

  if (
    value.type !== undefined &&
    (typeof value.type !== "string" || !JSON_SCHEMA_TYPES.has(value.type))
  ) {
    throw new Error(
      `Tool parameters contain an invalid JSON schema type at ${path}: ${toolName}`,
    );
  }

  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      throw new Error(
        `Tool parameters properties must be an object at ${path}: ${toolName}`,
      );
    }
    for (const [propertyName, propertySchema] of Object.entries(
      value.properties,
    )) {
      validateSchemaNode(
        propertySchema,
        toolName,
        `${path}.properties.${propertyName}`,
        true,
      );
    }
  }

  validateSchemaArray(value, "required", toolName, path, (item, index) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error(
        `Tool parameters required entries must be non-empty strings at ${path}.required[${index}]: ${toolName}`,
      );
    }
  });
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    validateSchemaArray(value, keyword, toolName, path, (item, index) =>
      validateSchemaNode(item, toolName, `${path}.${keyword}[${index}]`, true),
    );
  }

  if (value.items !== undefined) {
    validateSchemaNode(value.items, toolName, `${path}.items`, true);
  }
  if (value.additionalProperties !== undefined) {
    validateSchemaNode(
      value.additionalProperties,
      toolName,
      `${path}.additionalProperties`,
      true,
    );
  }
  if (value.enum !== undefined && !Array.isArray(value.enum)) {
    throw new Error(
      `Tool parameters enum must be an array at ${path}: ${toolName}`,
    );
  }
}

function validateSchemaArray(
  schema: Record<string, unknown>,
  keyword: string,
  toolName: string,
  path: string,
  validateItem: (item: unknown, index: number) => void,
): void {
  const value = schema[keyword];
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    throw new Error(
      `Tool parameters ${keyword} must be an array at ${path}: ${toolName}`,
    );
  }
  value.forEach(validateItem);
}

function cloneParameters(parameters: JsonObject, name: string): JsonObject {
  return cloneJsonObject(parameters, `Tool parameters: ${name}`);
}

function isToolExecute(value: unknown): value is Tool["execute"] {
  return typeof value === "function";
}

function isToolAuthorize(
  value: unknown,
): value is NonNullable<Tool["authorize"]> {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneTool(tool: Tool): Tool {
  return {
    ...tool,
    parameters: cloneParameters(tool.parameters, tool.name),
  };
}

function validateInputNode(
  schema: Record<string, unknown>,
  value: unknown,
  path: string,
  toolName: string,
): void {
  if (schema.const !== undefined && !sameJson(schema.const, value)) {
    throw new Error(`Invalid input at ${path} for tool ${toolName}.`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((item) => sameJson(item, value))
  ) {
    throw new Error(`Invalid input at ${path} for tool ${toolName}.`);
  }

  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const alternatives = schema[keyword];
    if (!Array.isArray(alternatives)) continue;
    const matches = alternatives.filter((alternative) => {
      try {
        if (!isRecord(alternative)) return false;
        validateInputNode(alternative, value, path, toolName);
        return true;
      } catch {
        return false;
      }
    }).length;
    if (keyword === "allOf" && matches !== alternatives.length) {
      throw new Error(`Invalid input at ${path} for tool ${toolName}.`);
    }
    if (keyword === "anyOf" && matches === 0) {
      throw new Error(`Invalid input at ${path} for tool ${toolName}.`);
    }
    if (keyword === "oneOf" && matches !== 1) {
      throw new Error(`Invalid input at ${path} for tool ${toolName}.`);
    }
  }

  const type = schema.type;
  if (typeof type === "string" && !matchesType(type, value)) {
    throw new Error(`Invalid input at ${path} for tool ${toolName}.`);
  }

  if (type === "object" || schema.properties !== undefined) {
    if (!isRecord(value)) {
      throw new Error(`Invalid input at ${path} for tool ${toolName}.`);
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const property of required) {
      if (typeof property === "string" && !(property in value)) {
        throw new Error(
          `Missing required input ${path}.${property} for tool ${toolName}.`,
        );
      }
    }
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [property, propertyValue] of Object.entries(value)) {
      const propertySchema = properties[property];
      if (propertySchema === undefined) {
        if (schema.additionalProperties === false) {
          throw new Error(
            `Unexpected input ${path}.${property} for tool ${toolName}.`,
          );
        }
        if (isRecord(schema.additionalProperties)) {
          validateInputNode(
            schema.additionalProperties,
            propertyValue,
            `${path}.${property}`,
            toolName,
          );
        }
        continue;
      }
      if (isRecord(propertySchema)) {
        validateInputNode(
          propertySchema,
          propertyValue,
          `${path}.${property}`,
          toolName,
        );
      }
    }
  }

  if (type === "array" || schema.items !== undefined) {
    if (!Array.isArray(value)) {
      throw new Error(`Invalid input at ${path} for tool ${toolName}.`);
    }
    if (isRecord(schema.items)) {
      value.forEach((item, index) =>
        validateInputNode(
          schema.items as Record<string, unknown>,
          item,
          `${path}[${index}]`,
          toolName,
        ),
      );
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer")
    return typeof value === "number" && Number.isInteger(value);
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
