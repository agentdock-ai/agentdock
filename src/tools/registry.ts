import type { Tool } from "../agent/types.js";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  requiresApproval: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (!tool.name.trim()) {
      throw new Error("Tool name must not be empty.");
    }
    if (!tool.description.trim()) {
      throw new Error(`Tool description must not be empty: ${tool.name}`);
    }
    validateParameters(tool.parameters, tool.name);
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
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

function validateParameters(parameters: Record<string, unknown>, name: string): void {
  if (
    parameters === null ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  ) {
    throw new Error(`Tool parameters must be a JSON schema object: ${name}`);
  }

  if (
    parameters.type !== undefined &&
    (typeof parameters.type !== "string" || !JSON_SCHEMA_TYPES.has(parameters.type))
  ) {
    throw new Error(`Tool parameters contain an invalid JSON schema type: ${name}`);
  }
}

function cloneTool(tool: Tool): Tool {
  return {
    ...tool,
    parameters: structuredClone(tool.parameters),
  };
}
