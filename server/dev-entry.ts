import { createApp } from "./app.ts";
import { getDb } from "./db.ts";
import { seedDefaults } from "./seed.ts";

export function createDevApp() {
  seedDefaults(getDb());
  return createApp();
}
