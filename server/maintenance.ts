/**
 * Maintenance gate: lets a backup restore swap the database and uploads folder with nothing else running.
 *
 * Every API/MCP request, streamed download and background job holds the gate while it runs (`enter`). `exclusive`
 * stops new work (503 with Retry-After), waits for what's running to finish, runs its function, then reopens. Work
 * that started before the swap therefore never resumes on a closed database handle or a moved uploads folder.
 */
import type { MiddlewareHandler } from "hono";
import { AppError } from "./context.ts";

let active = 0;
let closed = false;
let idle: (() => void)[] = [];

export const MAINTENANCE_MESSAGE = "A backup is being restored; try again in a moment";

/** Hold the gate; call the returned function once when done. Throws 503 while a restore is running. */
export function enter(): () => void {
  if (closed) throw new AppError(503, MAINTENANCE_MESSAGE);
  active++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active--;
    if (active === 0) for (const wake of idle.splice(0)) wake();
  };
}

/** True while `exclusive` is draining or running. */
export const isClosed = () => closed;

/** Hold the gate for the whole request. Paths that take the gate themselves (restore) are skipped. */
export function gate(skip: (path: string) => boolean = () => false): MiddlewareHandler {
  return async (c, next) => {
    if (skip(c.req.path)) return next();
    let release: () => void;
    try {
      release = enter();
    } catch (e) {
      c.header("Retry-After", "30");
      throw e;
    }
    try {
      await next();
    } finally {
      release();
    }
  };
}

/**
 * Run `fn` with nothing else holding the gate. New work is turned away while waiting; if running work hasn't finished
 * within `timeoutMs`, the gate reopens and this throws 503 without running `fn`.
 */
export async function exclusive<T>(fn: () => T | Promise<T>, timeoutMs = 60_000): Promise<T> {
  if (closed) throw new AppError(409, "A restore is already running");
  closed = true;
  try {
    if (active > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake!: () => void;
      const drained = await Promise.race([
        new Promise<boolean>((resolve) => {
          wake = () => resolve(true);
          idle.push(wake);
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
      clearTimeout(timer);
      idle = idle.filter((w) => w !== wake);
      if (!drained) throw new AppError(503, "The app is busy; try the restore again in a minute");
    }
    return await fn();
  } finally {
    closed = false;
  }
}
