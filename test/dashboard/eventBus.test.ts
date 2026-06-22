import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../../src/dashboard/EventBus.js";

describe("EventBus", () => {
  it("delivers published events to subscribers", () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.subscribe((e) => seen.push(e.event));
    bus.publish({ event: "a" });
    bus.publish({ event: "b" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("stops delivery after unsubscribe", () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const off = bus.subscribe(fn);
    bus.publish({ event: "a" });
    off();
    bus.publish({ event: "b" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("isolates a throwing subscriber from others", () => {
    const bus = new EventBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe(good);
    expect(() => bus.publish({ event: "a" })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});
