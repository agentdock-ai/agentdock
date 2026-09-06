import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MongoDBCheckpoint } from "../src/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MongoDBCheckpoint", () => {
  it("rejects an empty connection string", () => {
    expect(() => new MongoDBCheckpoint({ connectionString: "" })).toThrow(
      /connectionString must be a non-empty string/,
    );
  });

  it("creates a saver without connecting until initialization", () => {
    const checkpoint = new MongoDBCheckpoint({
      connectionString: "mongodb://localhost:27017",
    });

    expect(checkpoint.saver).toBeDefined();
  });

  it("initializes and closes the client exactly once", async () => {
    const checkpoint = new MongoDBCheckpoint({
      connectionString: "mongodb://localhost:27017",
    });
    const connect = vi
      .spyOn(MongoClient.prototype, "connect")
      .mockResolvedValue(MongoClient.prototype);
    const setup = vi.spyOn(checkpoint.saver, "setup").mockResolvedValue([]);
    const close = vi.spyOn(MongoClient.prototype, "close").mockResolvedValue();

    await Promise.all([checkpoint.initialize(), checkpoint.initialize()]);
    await checkpoint.close();
    await checkpoint.close();

    expect(connect).toHaveBeenCalledOnce();
    expect(setup).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
