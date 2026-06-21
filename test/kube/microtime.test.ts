import { describe, it, expect } from "vitest";
import { toMicroTimeString } from "../../src/kube/KubeLeaseClient.js";

describe("toMicroTimeString", () => {
  it("pads millisecond ISO to microsecond precision (6 fractional digits)", () => {
    expect(toMicroTimeString("2026-06-21T15:25:31.178Z")).toBe("2026-06-21T15:25:31.178000Z");
  });

  it("produces 6 fractional digits for a time with no millis", () => {
    // new Date normalizes to .000Z, then padded to .000000Z
    expect(toMicroTimeString("2026-06-21T15:25:31Z")).toBe("2026-06-21T15:25:31.000000Z");
  });

  it("round-trips back to a parseable date", () => {
    const micro = toMicroTimeString(new Date(1_700_000_000_178).toISOString());
    expect(micro).toMatch(/\.\d{6}Z$/);
    expect(Number.isNaN(new Date(micro).getTime())).toBe(false);
  });
});
