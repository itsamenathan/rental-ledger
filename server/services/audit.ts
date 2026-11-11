import { and, desc, eq, notInArray } from "drizzle-orm";
import type { DB } from "../db.ts";
import { apiKeys, auditLog, users } from "../db/schema.ts";

export interface AuditQuery {
  entity?: string;
  entity_id?: number;
  limit: number;
  offset?: number;
  /** leave out sign-ins/outs */
  hide_logins?: boolean;
}

/** Recent changes, newest first, with the user and API key that made them. */
export function listAudit(db: DB, q: AuditQuery) {
  return db
    .select({
      id: auditLog.id,
      at: auditLog.at,
      via: auditLog.via,
      action: auditLog.action,
      entity: auditLog.entity,
      entity_id: auditLog.entityId,
      changes: auditLog.changes,
      user_id: auditLog.userId,
      user_email: users.email,
      api_key_id: auditLog.apiKeyId,
      api_key_name: apiKeys.name,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.userId))
    .leftJoin(apiKeys, eq(apiKeys.id, auditLog.apiKeyId))
    .where(
      and(
        q.entity ? eq(auditLog.entity, q.entity) : undefined,
        q.entity_id ? eq(auditLog.entityId, q.entity_id) : undefined,
        q.hide_logins ? notInArray(auditLog.action, ["login", "logout"]) : undefined,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(q.limit)
    .offset(q.offset ?? 0)
    .all();
}
