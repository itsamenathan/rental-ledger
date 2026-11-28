import { and, desc, eq, inArray, isNull, notInArray, or, type SQL } from "drizzle-orm";
import { requireInstanceAdmin, type Actor } from "../context.ts";
import type { DB } from "../db.ts";
import { apiKeys, auditLog, memberships, users } from "../db/schema.ts";
import { currentPortfolioId } from "../portfolio.ts";

export interface AuditQuery {
  entity?: string;
  entity_id?: number;
  limit: number;
  offset?: number;
  /** leave out sign-ins/outs */
  hide_logins?: boolean;
}

/**
 * The current portfolio's entries, plus entries about a login (sign-ins, password changes, preferences, the login
 * being made or changed) of people who belong to it: decided by whom the entry is about, never by who made it, so the
 * server's administrator changing someone in another portfolio doesn't show here. Another portfolio's entries never
 * show.
 */
function visibleInPortfolio(db: DB) {
  const pid = currentPortfolioId(db);
  const members = db.select({ id: memberships.userId }).from(memberships).where(eq(memberships.portfolioId, pid));
  return or(
    eq(auditLog.portfolioId, pid),
    and(
      isNull(auditLog.portfolioId),
      inArray(auditLog.entity, ["user", "user_settings"]),
      inArray(auditLog.entityId, members),
    ),
  );
}

/** Recent changes in this portfolio, newest first, with the user and API key that made them. */
export function listAudit(db: DB, q: AuditQuery) {
  return query(db, q, visibleInPortfolio(db));
}

/**
 * The server's own activity (Settings → Server activity, its administrator): backups and restores, logins being made
 * or changed, sign-ins, and portfolios being created, archived or looked into. A portfolio's own entries stay in its own log.
 */
export function listServerAudit(db: DB, actor: Actor, q: AuditQuery) {
  requireInstanceAdmin(actor);
  return query(db, q, or(isNull(auditLog.portfolioId), eq(auditLog.entity, "portfolio")));
}

function query(db: DB, q: AuditQuery, visible: SQL | undefined) {
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
        visible,
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
