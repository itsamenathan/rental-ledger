import { z } from "zod";
import { eq } from "drizzle-orm";
import type { DB } from "../db.ts";
import { users } from "../db/schema.ts";
import { audit, badRequest, diff, type Actor } from "../context.ts";

/**
 * A person's own preferences (how the app looks and behaves for them, not ledger data), stored as JSON in
 * `users.settings`. To add one: put its validator in `fields` and its default in `DEFAULTS`; no migration needed.
 * Only keys the person changed are stored, so a default changed later reaches everyone who never picked a value.
 */
const fields = {
  /** First day of the week on the calendar: 0 = Sunday, 1 = Monday, 6 = Saturday (the choices Google Calendar offers) */
  week_start: z.literal([0, 1, 6]),
};

export type UserSettings = { [K in keyof typeof fields]: z.output<(typeof fields)[K]> };

export const DEFAULTS: UserSettings = { week_start: 0 };

/** Fields have no `.default()`, so `.partial()` leaves unsent keys out (zod 4 would fill defaults inside it). */
export const userSettingsPatch = z.strictObject(fields).partial();

const KEYS = Object.keys(fields) as (keyof UserSettings)[];

function stored(db: DB, userId: number): Record<string, unknown> {
  const row = db.select({ settings: users.settings }).from(users).where(eq(users.id, userId)).get();
  const s = row?.settings;
  return s && typeof s === "object" && !Array.isArray(s) ? (s as Record<string, unknown>) : {};
}

/**
 * Every setting with its value (the default where nothing valid is stored). Never throws: `auth/me` reads this, and a
 * bad stored value (e.g. one a later version dropped) must not look like being signed out.
 */
export function getUserSettings(db: DB, userId: number): UserSettings {
  const raw = stored(db, userId);
  const out: Record<string, unknown> = { ...DEFAULTS };
  for (const k of KEYS) {
    const v = fields[k].safeParse(raw[k]);
    if (v.success) out[k] = v.data;
  }
  return out as UserSettings;
}

/** Change some of the caller's own settings; keys not sent keep their value. Returns all settings. */
export function updateUserSettings(db: DB, actor: Actor, raw: unknown): UserSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw badRequest("Send an object of settings");
  const patch = userSettingsPatch.parse(raw) as Partial<UserSettings>;
  const userId = actor.user.id;
  const before = getUserSettings(db, userId);
  if (Object.keys(patch).length) {
    db.update(users)
      .set({ settings: { ...stored(db, userId), ...patch } })
      .where(eq(users.id, userId))
      .run();
  }
  const after = getUserSettings(db, userId);
  const changes = diff(before, after);
  if (Object.keys(changes).length) audit(db, actor, "update", "user_settings", userId, changes);
  return after;
}
