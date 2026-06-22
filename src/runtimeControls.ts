/**
 * Mutable runtime knobs the dashboard can adjust without a restart. Currently
 * just the demo lease-hold; kept as a tiny object so the tool runner reads the
 * live value and the /demo/run endpoint can change it per launch.
 */
export interface RuntimeControls {
  demoHoldMs: number;
}

export function createRuntimeControls(initialHoldMs: number): RuntimeControls {
  return { demoHoldMs: initialHoldMs };
}
