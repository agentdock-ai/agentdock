import type { Tool } from "../agent/types.js";

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return Array.from(this.tools.values());
  }

  schemas(): ToolSchema[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  clear(): void {
    this.tools.clear();
  }
}

export const defaultToolRegistry = new ToolRegistry();

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

export function registerTool(tool: Tool): void {
  defaultToolRegistry.register(tool);
}

export function getTool(name: string): Tool | undefined {
  return defaultToolRegistry.get(name);
}

export function getTools(): Tool[] {
  return defaultToolRegistry.list();
}

export function getToolSchemas(): ToolSchema[] {
  return defaultToolRegistry.schemas();
}
