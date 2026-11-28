import { createApp } from "./app.ts";
import { getDb } from "./db.ts";
import { seedFirstRun } from "./seed.ts";
import { initTelemetry } from "./telemetry.ts";

export function createDevApp() {
  initTelemetry();
  seedFirstRun(getDb());
  return createApp();
}
