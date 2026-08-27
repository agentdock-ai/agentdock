# AgentDock — Product Requirements Document

## 1. Product Summary

AgentDock is a flexible agent harness built on top of the Vercel AI SDK.

The Vercel AI SDK provides the underlying connection to AI models and the basic AI interaction capabilities. AgentDock adds the reusable harness engineering needed to run agents in a controlled and reliable way, including action orchestration, context management, memory management, tool execution, authorization, approvals, streaming, cancellation, and run persistence.

AgentDock is designed to be configurable rather than tied to one product or workflow. The application using it can provide its own tools, prompts, business rules, permissions, and persistence implementation.

## 2. Why We Are Building It

The Vercel AI SDK makes it easier to communicate with AI models, but applications still need to build the surrounding agent logic themselves. Each application may need to decide when tools can run, when approval is required, how a run is paused or resumed, how permissions are checked, and how run state is stored.

AgentDock centralizes that surrounding logic in a reusable harness. This allows applications to build different AI-agent products on top of the same reliable foundation without duplicating the run lifecycle, action handling, context management, memory management, and safety conditions.

## 3. Product Goal

The goal of AgentDock is to provide a flexible layer on top of the Vercel AI SDK that controls how an AI agent runs inside an application.

AgentDock should make it simple to define an agent’s actions, tools, context, memory, conditions, permissions, approvals, and run lifecycle while allowing the application to retain control over its own business logic, data, and user experience.

## 4. Initial Scope

The initial harness includes:

- A TypeScript agent runtime
- Support for running and streaming agent runs
- The ability to resume runs that require approval
- The ability to cancel runs
- A registry for application-defined tools
- Tool authorization support
- Session state with canonical conversation messages
- In-memory or durable run persistence through an injected store
- In-memory or durable session persistence through an injected store
- Provider helpers for connecting the harness to AI models through the Vercel AI SDK
- Typed APIs for backend applications

## 5. Out of Scope for the Initial Version

The initial version does not own or define:

- Product-specific prompts
- Product-specific tools
- Application user interfaces
- Business-specific authorization policies
- Application databases or storage systems
- A single required AI model provider
- End-user account or organization management

## 6. Intended Users

AgentDock is intended for backend developers building applications that need one or more AI agents and want a shared, configurable foundation for those agents.

## 7. Basic User Story

As a backend developer, I want to configure an AI model, register my application’s tools, define how runs are stored and authorized, and then execute an agent from my application through a typed API.

## 8. Success Criteria

AgentDock is successful when an application can:

1. Configure an agent with a model and run store.
2. Configure a session store and associate each run with a session.
3. Register and authorize its own tools.
4. Start an agent run and receive its result or stream.
5. Continue a session without manually passing message history between runs.
6. Pause for required approvals and resume the run later.
7. Cancel or inspect runs reliably.
8. Use the same infrastructure across multiple products or agent implementations.

## 9. Future Clarifications

The following areas can be expanded as the product vision becomes clearer:

- The primary types of applications AgentDock will serve
- The main problems and workflows agents should support
- The expected production scale and reliability requirements
- The supported model providers
- The long-term persistence and observability strategy
- Whether a user-facing dashboard or management layer is needed
- Detailed milestones and release priorities

## 10. Long-Term Product Direction

AgentDock should evolve into the harness engineering layer for AI agents. Its responsibility is not only to start a model call, but to manage the conditions around meaningful agent action.

Over time, the harness may provide reusable systems for:

- Deciding what context an agent needs at each step
- Managing short-term conversation context and long-term memory
- Selecting, sequencing, and validating agent actions
- Enforcing permissions, approvals, limits, and safety conditions
- Preserving state across interruptions and resumed runs
- Giving applications visibility into how an agent reached an outcome

The underlying model and AI SDK may change, but AgentDock should provide a stable orchestration layer for building dependable agent-powered products.
