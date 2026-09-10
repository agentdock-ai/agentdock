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

  it("validates TTL settings", () => {
    expect(
      () =>
        new RedisCheckpoint({
          url: "redis://localhost:6379",
          ttl: { defaultTTL: 0 },
        }),
    ).toThrow(/ttl\.defaultTTL must be positive/);
    expect(
      () =>
        new RedisCheckpoint({
          url: "redis://localhost:6379",
          ttl: { refreshOnRead: "yes" as unknown as boolean },
        }),
    ).toThrow(/ttl\.refreshOnRead must be a boolean/);
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

  it("reports connection failures and permits a retry", async () => {
    const checkpoint = new RedisCheckpoint({ url: "redis://localhost:6379" });
    const client = (
      checkpoint as unknown as {
        client: ReturnType<typeof createClient>;
      }
    ).client;
    const connect = vi
      .spyOn(client, "connect")
      .mockRejectedValueOnce(new Error("redis unavailable"))
      .mockResolvedValueOnce(client);
    vi.spyOn(client, "isOpen", "get").mockReturnValue(true);
    vi.spyOn(checkpoint.saver, "end").mockResolvedValue();

    await expect(checkpoint.initialize()).rejects.toThrow(
      /Failed to initialize Redis checkpoints/,
    );
    await checkpoint.initialize();
    expect(connect).toHaveBeenCalledTimes(2);
    await checkpoint.close();
  });

  it("does not end an unopened client after initialization fails", async () => {
    const checkpoint = new RedisCheckpoint({ url: "redis://localhost:6379" });
    const client = (
      checkpoint as unknown as {
        client: ReturnType<typeof createClient>;
      }
    ).client;
    vi.spyOn(client, "connect").mockRejectedValue(
      new Error("redis unavailable"),
    );
    vi.spyOn(client, "isOpen", "get").mockReturnValue(false);
    const end = vi.spyOn(checkpoint.saver, "end").mockResolvedValue();

    await expect(checkpoint.initialize()).rejects.toThrow();
    await checkpoint.close();
    expect(end).not.toHaveBeenCalled();
  });
});
