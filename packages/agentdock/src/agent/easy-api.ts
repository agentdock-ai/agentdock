import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { AnyAgentMiddleware } from "langchain";
import type { CheckpointAdapter } from "@agentdock/checkpoint";
import {
  AgentDock,
  type AgentDockDefaults,
  type AgentDockOptions,
} from "./agent-dock.js";
import type { ContextManagementOptions } from "./context-management.js";
import type {
  Tool,
  ToolAuthorizationInput,
  ToolAuthorizationResult,
} from "./types.js";
import type { RunCoordinator } from "./coordinator.js";
import { ToolRegistry } from "../tools/registry.js";

export interface AgentDockPolicy {
  authorize?(
    input: ToolAuthorizationInput & { tool: Tool },
  ): ToolAuthorizationResult | Promise<ToolAuthorizationResult>;
}

export interface AgentDockPersistence {
  checkpoint?: CheckpointAdapter;
  checkpointer?: BaseCheckpointSaver;
}

export interface CreateAgentDockOptions {
  model: BaseChatModel;
  instructions?: string;
  tools?: Record<string, Tool>;
  persistence?: AgentDockPersistence;
  policy?: AgentDockPolicy;
  defaults?: AgentDockDefaults;
  coordinator?: RunCoordinator;
  middleware?: readonly AnyAgentMiddleware[];
  contextManagement?: ContextManagementOptions;
}

/** Creates the simple typed-tool facade over the advanced AgentDock runtime. */
export function createAgentDock(options: CreateAgentDockOptions): AgentDock {
  const registry = new ToolRegistry();
  for (const tool of Object.values(options.tools ?? {})) {
    registry.register(withPolicy(tool, options.policy));
  }

  const defaults = {
    ...options.defaults,
    ...(options.instructions !== undefined
      ? { systemPrompt: options.instructions }
      : {}),
  };
  const advancedOptions: AgentDockOptions = {
    model: options.model,
    registry,
    defaults,
    ...(options.persistence?.checkpoint
      ? { checkpoint: options.persistence.checkpoint }
      : {}),
    ...(options.persistence?.checkpointer
      ? { checkpointer: options.persistence.checkpointer }
      : {}),
    ...(options.coordinator ? { coordinator: options.coordinator } : {}),
    ...(options.middleware ? { middleware: options.middleware } : {}),
    ...(options.contextManagement
      ? { contextManagement: options.contextManagement }
      : {}),
  };
  return new AgentDock(advancedOptions);
}

function withPolicy(tool: Tool, policy: AgentDockPolicy | undefined): Tool {
  if (!policy?.authorize) return tool;
  const existing = tool.authorize;
  return {
    ...tool,
    authorize: async (input) => {
      if (existing) {
        const result = await existing(input);
        if (!result.allowed) return result;
      }
      return policy.authorize!({ tool, ...input });
    },
  };
}
