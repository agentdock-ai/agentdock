import type { JSONSchema } from "@langchain/core/utils/json_schema";
import type { Tool } from "../agent/types.js";
import type { ToolSchema } from "@agentdock/contracts";

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
): asserts parameters is JSONSchema {
  if (!isRecord(parameters)) {
    throw new Error(`Tool parameters must be a JSON schema object: ${name}`);
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

function cloneParameters(parameters: JSONSchema, name: string): JSONSchema {
  try {
    return structuredClone(parameters);
  } catch {
    throw new Error(`Tool parameters must be JSON-serializable: ${name}`);
  }
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
    parameters: structuredClone(tool.parameters),
  };
}
