import { createClient } from "redis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RedisCheckpoint } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RedisCheckpoint", () => {
  it("rejects an empty URL", () => {
    expect(() => new RedisCheckpoint({ url: "" })).toThrow(
      /url must be a non-empty string/,
    );
  });

  it("creates a saver without connecting until initialization", async () => {
    const checkpoint = new RedisCheckpoint({
      url: "redis://localhost:6379",
    });

    expect(checkpoint.saver).toBeDefined();
    await checkpoint.close();
  });

  it("initializes and closes the client exactly once", async () => {
    const checkpoint = new RedisCheckpoint({
      url: "redis://localhost:6379",
    });
    const client = (
      checkpoint as unknown as {
        client: ReturnType<typeof createClient>;
      }
    ).client;
    const connect = vi
      .spyOn(client, "connect")
      .mockImplementation(async () => client);
    vi.spyOn(client, "isOpen", "get").mockReturnValue(true);
    const end = vi.spyOn(checkpoint.saver, "end").mockResolvedValue();

    await Promise.all([checkpoint.initialize(), checkpoint.initialize()]);
    await checkpoint.close();
    await checkpoint.close();

    expect(connect).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });
});
