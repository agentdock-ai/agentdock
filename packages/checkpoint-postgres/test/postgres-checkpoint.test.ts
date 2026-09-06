import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresCheckpoint } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PostgresCheckpoint", () => {
  it("rejects an empty connection string", () => {
    expect(() => new PostgresCheckpoint({ connectionString: "" })).toThrow(
      /connectionString must be a non-empty string/,
    );
  });

  it("creates a saver without connecting until initialization", () => {
    const checkpoint = new PostgresCheckpoint({
      connectionString: "postgresql://localhost/agentdock",
    });

    expect(checkpoint.saver).toBeDefined();
  });

  it("initializes and closes the saver exactly once", async () => {
    const checkpoint = new PostgresCheckpoint({
      connectionString: "postgresql://localhost/agentdock",
    });
    const setup = vi.spyOn(checkpoint.saver, "setup").mockResolvedValue();
    const end = vi.spyOn(checkpoint.saver, "end").mockResolvedValue();

    await Promise.all([checkpoint.initialize(), checkpoint.initialize()]);
    await checkpoint.close();
    await checkpoint.close();

    expect(setup).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
