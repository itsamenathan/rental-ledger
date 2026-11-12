/**
 * Logging and tracing.
 *
 * Logs: pino, JSON lines to stdout (LOG_LEVEL, default "info"). Each line carries trace_id/span_id when it was
 * written inside a traced request. With OTEL_LOGS_EXPORTER=otlp, every log line is also sent to the OTLP collector.
 *
 * Traces: on when OTEL_EXPORTER_OTLP_ENDPOINT is set (unless OTEL_TRACES_EXPORTER=none). One server span per
 * API/MCP request, child spans for each SQL statement and MCP tool call. W3C traceparent is honoured.
 *
 * Standard OTel env vars apply: OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_HEADERS, OTEL_SERVICE_NAME,
 * OTEL_RESOURCE_ATTRIBUTES. Nothing is exported unless configured; the CLI never exports.
 */
import { Writable } from "node:stream";
import {
  context,
  INVALID_SPAN_CONTEXT,
  logs,
  propagation,
  SeverityNumber,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type Span,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { detectResources, envDetector, resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import type { MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import pino from "pino";

const env = process.env;
const SERVICE_NAME = env.OTEL_SERVICE_NAME || "rental-ledger";
const otlpConfigured = !!(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
export const tracingEnabled = otlpConfigured && env.OTEL_TRACES_EXPORTER !== "none" && env.OTEL_SDK_DISABLED !== "true";
const otelLogsEnabled =
  !!(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) &&
  (env.OTEL_LOGS_EXPORTER ?? "").split(",").includes("otlp") &&
  env.OTEL_SDK_DISABLED !== "true";

export const tracer = trace.getTracer("rental-ledger");

// ---------------------------------------------------------------- logs

const resource = () =>
  resourceFromAttributes({ "service.name": SERVICE_NAME }).merge(detectResources({ detectors: [envDetector] }));

let loggerProvider: LoggerProvider | null = null;
let tracerProvider: TracerProvider | null = null;

const SEVERITY: Record<number, [SeverityNumber, string]> = {
  10: [SeverityNumber.TRACE, "TRACE"],
  20: [SeverityNumber.DEBUG, "DEBUG"],
  30: [SeverityNumber.INFO, "INFO"],
  40: [SeverityNumber.WARN, "WARN"],
  50: [SeverityNumber.ERROR, "ERROR"],
  60: [SeverityNumber.FATAL, "FATAL"],
};

/** Turns pino's JSON lines into OTel log records, linked to the trace they were written in. */
function otelLogStream() {
  loggerProvider = new LoggerProvider({
    resource: resource(),
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  });
  logs.setGlobalLoggerProvider(loggerProvider);
  const otel = loggerProvider.getLogger("rental-ledger");
  return new Writable({
    write(chunk, _enc, done) {
      try {
        const {
          level,
          time,
          msg,
          trace_id,
          span_id,
          pid: _p,
          hostname: _h,
          service: _s,
          ...rest
        } = JSON.parse(String(chunk)) as Record<string, unknown>;
        const attributes: Attributes = {};
        for (const [k, v] of Object.entries(rest))
          attributes[k] = v == null || typeof v !== "object" ? (v as string) : JSON.stringify(v);
        const [severityNumber, severityText] = SEVERITY[level as number] ?? [SeverityNumber.INFO, "INFO"];
        otel.emit({
          severityNumber,
          severityText,
          body: (msg as string) ?? "",
          attributes,
          timestamp: new Date(time as string),
          context:
            typeof trace_id === "string" && typeof span_id === "string"
              ? trace.setSpanContext(context.active(), {
                  traceId: trace_id,
                  spanId: span_id,
                  traceFlags: TraceFlags.SAMPLED,
                  isRemote: false,
                })
              : undefined,
        });
      } catch {
        /* never let telemetry break logging */
      }
      done();
    },
  });
}

/** The app logger. JSON to stdout; also to OTLP when OTEL_LOGS_EXPORTER=otlp. */
export const log = pino(
  {
    level: env.LOG_LEVEL || (env.VITEST ? "silent" : "info"),
    base: { service: SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    mixin() {
      const sc = trace.getActiveSpan()?.spanContext();
      return sc && trace.isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
    },
  },
  otelLogsEnabled
    ? pino.multistream([{ stream: process.stdout }, { stream: otelLogStream() }])
    : pino.destination({ dest: 1, sync: true }),
);

// ---------------------------------------------------------------- traces

const INIT = Symbol.for("rental-ledger.telemetry");

/** Start exporting traces if configured. Safe to call more than once (the dev server reloads modules). */
export function initTelemetry() {
  const g = globalThis as Record<symbol, unknown>;
  if (g[INIT]) return;
  g[INIT] = true;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  if (tracingEnabled) {
    tracerProvider = new TracerProvider({
      resource: resource(),
      spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
    });
    trace.setGlobalTracerProvider(tracerProvider);
  }
  log.info(
    { tracing: tracingEnabled, otel_logs: otelLogsEnabled, endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT || null },
    "telemetry initialised",
  );
}

/** Flush and stop exporters (call on shutdown). */
export async function shutdownTelemetry() {
  await Promise.allSettled([tracerProvider?.shutdown(), loggerProvider?.shutdown()]);
}

/** Run `fn` inside a child span. Works for sync and async functions; records errors. */
export function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => T): T {
  if (!tracingEnabled) return fn(trace.wrapSpanContext(INVALID_SPAN_CONTEXT));
  return tracer.startActiveSpan(name, { attributes }, (span) => {
    const fail = (e: unknown) => {
      span.recordException(e as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error)?.message });
    };
    try {
      const out = fn(span);
      if (out && typeof (out as { then?: unknown }).then === "function")
        return (out as unknown as Promise<unknown>).then(
          (v) => (span.end(), v),
          (e) => {
            fail(e);
            span.end();
            throw e;
          },
        ) as T;
      span.end();
      return out;
    } catch (e) {
      fail(e);
      span.end();
      throw e;
    }
  });
}

/**
 * The route pattern that handled the request (e.g. /api/transactions/:id), for low-cardinality span names.
 * Prefers the method-specific handler over ALL-method middleware and catch-alls.
 */
function routeOf(c: Parameters<MiddlewareHandler>[0]) {
  const routes = matchedRoutes(c);
  const pick =
    routes.findLast((r) => r.method !== "ALL" && !r.path.endsWith("*")) ??
    routes.findLast((r) => !r.path.endsWith("*"));
  return pick?.path ?? "unmatched";
}

/** Hono middleware: a server span + one access-log line per request. */
export const httpTelemetry: MiddlewareHandler = async (c, next) => {
  const started = performance.now();
  const parent = propagation.extract(context.active(), Object.fromEntries(c.req.raw.headers));
  const span = tracingEnabled
    ? tracer.startSpan(
        c.req.method,
        {
          kind: SpanKind.SERVER,
          attributes: { "http.request.method": c.req.method, "url.path": c.req.path, "url.scheme": "http" },
        },
        parent,
      )
    : null;
  const run = () => next();
  try {
    await (span ? context.with(trace.setSpan(parent, span), run) : run());
  } finally {
    const route = routeOf(c);
    const status = c.res.status;
    const actor = c.get("actor") as { user: { id: number }; via: string; apiKeyId: number | null } | null | undefined;
    const ms = Math.round((performance.now() - started) * 10) / 10;
    const fields = {
      method: c.req.method,
      route,
      path: c.req.path,
      status,
      duration_ms: ms,
      user_id: actor?.user.id,
      via: actor?.via,
      api_key_id: actor?.apiKeyId ?? undefined,
    };
    const write = () => {
      if (status >= 500) log.error(fields, "request failed");
      else log.info(fields, "request");
    };
    if (span) {
      span.updateName(`${c.req.method} ${route}`);
      span.setAttributes({
        "http.route": route,
        "http.response.status_code": status,
        ...(actor ? { "enduser.id": String(actor.user.id), "app.via": actor.via } : {}),
      });
      if (c.error) span.recordException(c.error);
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      context.with(trace.setSpan(parent, span), write);
      span.end();
    } else write();
  }
};

/** Wrap better-sqlite3 statements so each query becomes a child span of the current request. */
export function instrumentSqlite<T extends { prepare: (sql: string) => object }>(client: T): T {
  if (!tracingEnabled) return client;
  const prepare = client.prepare.bind(client);
  client.prepare = ((sql: string) => {
    const stmt = prepare(sql) as Record<string, unknown>;
    const op = sql.trim().split(/\s+/, 1)[0]!.toUpperCase();
    for (const m of ["run", "get", "all", "iterate"] as const) {
      const fn = stmt[m] as ((...a: unknown[]) => unknown) | undefined;
      if (typeof fn !== "function") continue;
      stmt[m] = (...args: unknown[]) =>
        // only trace queries made inside a traced request (skip startup/migrations)
        trace.getActiveSpan()
          ? withSpan(
              `sqlite ${op}`,
              { "db.system.name": "sqlite", "db.operation.name": op, "db.query.text": sql.slice(0, 2000) },
              () => fn.apply(stmt, args),
            )
          : fn.apply(stmt, args);
    }
    return stmt;
  }) as T["prepare"];
  return client;
}
