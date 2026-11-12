import { createApp } from "./app.ts";
import { getDb } from "./db.ts";
import { seedDefaults } from "./seed.ts";
import { initTelemetry } from "./telemetry.ts";

export function createDevApp() {
  initTelemetry();
  seedDefaults(getDb());
  return createApp();
}
