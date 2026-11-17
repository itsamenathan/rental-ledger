import { resolve } from "node:path";

const env = process.env;
const dataDir = resolve(env.DATA_DIR ?? "./data");

export const config = {
  production: env.NODE_ENV === "production",
  port: Number(env.PORT ?? 3000),
  dataDir,
  databasePath: env.DATABASE_PATH ?? resolve(dataDir, "rental.db"),
  uploadsDir: env.UPLOADS_DIR ?? resolve(dataDir, "uploads"),
  /** External URL, e.g. https://rental.example.com — needed for OIDC callbacks. */
  publicUrl: env.PUBLIC_URL?.replace(/\/$/, ""),
  /** Secure cookies. Defaults on in production; set COOKIE_SECURE=false behind plain HTTP. */
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === "true" : env.NODE_ENV === "production",
  sessionDays: Number(env.SESSION_DAYS ?? 30),
  maxUploadBytes: Number(env.MAX_UPLOAD_MB ?? 20) * 1024 * 1024,
  /** Largest backup zip accepted by POST /api/backup/restore. */
  maxRestoreBytes: Number(env.MAX_RESTORE_MB ?? 1024) * 1024 * 1024,
  /**
   * Download linked booking calendars in the background every this many minutes (0 = only when the Calendar page
   * is opened or someone clicks Refresh). Production server only.
   */
  calendarRefreshMinutes: Math.max(0, Number(env.CALENDAR_REFRESH_MINUTES ?? 180) || 0),
  /** Disable username/password login (OIDC only). */
  disablePasswordLogin: env.DISABLE_PASSWORD_LOGIN === "true",
  oidc: env.OIDC_ISSUER
    ? {
        issuer: env.OIDC_ISSUER,
        clientId: env.OIDC_CLIENT_ID ?? "",
        clientSecret: env.OIDC_CLIENT_SECRET ?? "",
        name: env.OIDC_NAME ?? "SSO",
        /** Create accounts for unknown OIDC users (as `member`). Otherwise they must already exist by email. */
        autoCreate: env.OIDC_AUTO_CREATE === "true",
      }
    : null,
};
