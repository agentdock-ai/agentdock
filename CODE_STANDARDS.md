# Code Standards

## Simplicity first

- Prefer the smallest clear solution that fully satisfies the requirement.
- Avoid overengineering, speculative abstractions, and unnecessary configuration.
- Reduce code when the same behavior can be achieved without harming clarity or safety.
- Code should be understandable without requiring extensive explanation.

## Design

- Keep each module, class, and function focused on one responsibility.
- Avoid God files, God classes, and functions that coordinate too many concerns.
- Separate domain logic, infrastructure, configuration, and presentation concerns.
- Use abstractions only when they remove real duplication or support a real requirement.
- Prefer explicit control flow when it preserves type safety and improves readability.

## DRY

- Do not duplicate validation, normalization, serialization, or shared business rules.
- Centralize genuinely shared behavior in small, focused utilities or base abstractions.
- Do not create abstractions solely to eliminate a few readable lines.
- Keep related configuration and registration in one place.

## Type safety

- Use precise types at public and internal boundaries.
- Avoid `any`, unchecked casts, and untyped escape hatches.
- Model valid states with discriminated unions and exhaustive handling where appropriate.
- Validate external input at the boundary before using it internally.
- Keep provider, adapter, and storage contracts explicit.

## Files and APIs

- Keep files small and cohesive.
- Keep public APIs minimal and intentional.
- Do not expose internal implementation details without a clear consumer need.
- Remove obsolete APIs when they are no longer required and update all references.
- Do not keep multiple implementations of the same behavior.

## Error handling

- Fail early with clear, actionable errors.
- Do not silently ignore invalid input or unsupported states.
- Preserve useful context when propagating errors.
- Avoid hidden fallback behavior that changes the caller's requested configuration.

## Comments and documentation

- Write comments only when they clarify intent, constraints, or non-obvious behavior.
- Keep comments short, direct, and easy to understand.
- Prefer clear names and structure over explanatory comments.
- Remove comments that describe outdated behavior.

## Testing

- Test core behavior, public contracts, error paths, and important state transitions.
- Prefer focused unit tests for deterministic logic and contract tests for interchangeable adapters.
- Tests must verify real behavior; do not add fake coverage that cannot catch regressions.
- Keep test setup proportional to the behavior being tested.

## Maintenance

- Remove dead code, unused imports, stale configuration, and obsolete dependencies.
- Keep naming, error messages, and patterns consistent across modules.
- Make the smallest safe change that solves the current problem.
- Run formatting, typechecking, tests, and relevant builds before considering work complete.
