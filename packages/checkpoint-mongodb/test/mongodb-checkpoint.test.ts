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

  it("validates database and collection names", () => {
    for (const options of [
      { database: "" },
      { collection: "  " },
      { writesCollection: "" },
    ]) {
      expect(
        () =>
          new MongoDBCheckpoint({
            connectionString: "mongodb://localhost:27017",
            ...options,
          }),
      ).toThrow(/must be a non-empty string/);
    }
    expect(
      () =>
        new MongoDBCheckpoint({
          connectionString: "mongodb://localhost:27017",
          collection: "checkpoints",
          writesCollection: "checkpoints",
        }),
    ).toThrow(/must be different/);
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

  it("reports setup failures and permits a retry", async () => {
    const checkpoint = new MongoDBCheckpoint({
      connectionString: "mongodb://localhost:27017",
    });
    vi.spyOn(MongoClient.prototype, "connect").mockResolvedValue(
      MongoClient.prototype,
    );
    const setup = vi
      .spyOn(checkpoint.saver, "setup")
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([]);
    vi.spyOn(MongoClient.prototype, "close").mockResolvedValue();

    await expect(checkpoint.initialize()).rejects.toThrow(
      /Failed to initialize MongoDB checkpoints/,
    );
    await checkpoint.initialize();
    expect(setup).toHaveBeenCalledTimes(2);
    await checkpoint.close();
  });

  it("closes its client after initialization fails", async () => {
    const checkpoint = new MongoDBCheckpoint({
      connectionString: "mongodb://localhost:27017",
    });
    vi.spyOn(MongoClient.prototype, "connect").mockResolvedValue(
      MongoClient.prototype,
    );
    vi.spyOn(checkpoint.saver, "setup").mockRejectedValue(
      new Error("database unavailable"),
    );
    const close = vi.spyOn(MongoClient.prototype, "close").mockResolvedValue();

    await expect(checkpoint.initialize()).rejects.toThrow();
    await checkpoint.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
