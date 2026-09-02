import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { describeAccount, isSupportedSize } from "../src/mcp.js";

describe("size validation", () => {
  it("accepts auto and sizes inside the supported range", () => {
    for (const size of ["auto", "1024x1024", "1536x1024", "2048x2048", "256x256", "4096x4096"]) {
      expect(isSupportedSize(size)).toBe(true);
    }
  });

  it("rejects malformed or out-of-range sizes", () => {
    for (const size of ["1024", "1024*1024", "128x128", "8192x8192", "large", "1024x1024 "]) {
      expect(isSupportedSize(size)).toBe(false);
    }
  });
});

describe("describeAccount", () => {
  it("converts quota units into a readable balance", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const described = describeAccount(
      { username: "rivermoon", group: "default", quota: 6_170_000, used_quota: 2_500_000 },
      config,
    );

    expect(described.text).toContain("Remaining balance: $12.34");
    expect(described.text).toContain("Used so far: $5.00");
    expect(described.text).toContain('standard uses group "default"');
    expect(described.structured.remaining_usd).toBeCloseTo(12.34);
    expect(described.structured.estimated_standard_images_left).toBeUndefined();
  });

  it("estimates remaining images when per-image costs are configured", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      STANDARD_IMAGE_COST_USD: "0.04",
      PRO_IMAGE_COST_USD: "0.25",
    });
    const described = describeAccount({ username: "rivermoon", group: "default", quota: 500_000 }, config);

    expect(described.structured.estimated_standard_images_left).toBe(25);
    expect(described.structured.estimated_pro_images_left).toBe(4);
    expect(described.text).toContain("Roughly 25 more standard image(s)");
  });

  it("reports an unavailable balance instead of NaN", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    const described = describeAccount({ username: "rivermoon", group: "default" }, config);

    expect(described.text).toContain("Remaining balance: unavailable");
    expect(described.structured.remaining_usd).toBeUndefined();
  });
});
