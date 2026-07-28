import { describe, expect, it } from "vitest";

import { mapConcurrent } from "../src/concurrency.js";

describe("mapConcurrent", () => {
  it("preserves input order while limiting active work", async () => {
    let active = 0;
    let peak = 0;

    const results = await mapConcurrent([3, 2, 1, 0], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, value));
      active -= 1;
      return value * 2;
    });

    expect(results).toEqual([6, 4, 2, 0]);
    expect(peak).toBe(2);
  });

  it("rejects invalid concurrency", async () => {
    await expect(mapConcurrent([1], 0, async (value) => value)).rejects.toThrow(
      "concurrency must be a positive safe integer",
    );
  });
});
