import type { DashboardEvent } from "./types.js";

export type DashboardListener = (event: DashboardEvent) => void;

/**
 * Minimal in-process publish/subscribe for dashboard events. A throwing
 * subscriber is isolated so one bad consumer can't break the others (the SSE
 * stream and the MetricsStore are independent consumers).
 */
export class EventBus {
  private listeners = new Set<DashboardListener>();

  subscribe(listener: DashboardListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: DashboardEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Isolate consumers; a failing subscriber must not affect others.
      }
    }
  }
}
