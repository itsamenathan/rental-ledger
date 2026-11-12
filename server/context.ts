import type { DB } from "./db.ts";
import { auditLog } from "./db/schema.ts";
import { log } from "./telemetry.ts";

export type Role = "admin" | "member" | "viewer";
export type Via = "web" | "api" | "mcp" | "cli";

export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
}

/** Who is performing an operation. Every write records this in the audit log. */
export interface Actor {
  user: User;
  apiKeyId: number | null;
  /** read-only API keys and viewer accounts cannot write */
  canWrite: boolean;
  via: Via;
}

export class AppError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what: string) => new AppError(404, `${what} not found`);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, msg, details);

export function requireWrite(actor: Actor) {
  if (!actor.canWrite) throw new AppError(403, "This account or API key is read-only");
}
export function requireAdmin(actor: Actor) {
  if (actor.user.role !== "admin") throw new AppError(403, "Admin only");
}

export function audit(
  db: DB,
  actor: Actor | null,
  action: string,
  entity: string,
  entityId: number | null,
  changes?: unknown,
) {
  log.info(
    { audit: { action, entity, entity_id: entityId }, user_id: actor?.user.id, via: actor?.via ?? "cli" },
    `${action} ${entity}`,
  );
  db.insert(auditLog)
    .values({
      userId: actor?.user.id ?? null,
      apiKeyId: actor?.apiKeyId ?? null,
      via: actor?.via ?? "cli",
      action,
      entity,
      entityId,
      changes: changes === undefined ? null : changes,
    })
    .run();
}

/** Field-level diff for audit entries. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: Record<string, [unknown, unknown]> = {};
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k]) out[k] = [before[k], after[k]];
  }
  return out;
}

export const cents = (dollars: number) => Math.round(dollars * 100);
export const dollars = (c: number | null | undefined) => (c == null ? null : c / 100);
