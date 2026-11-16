import { Hono, type Context } from "hono";
import { z } from "zod";
import { getDb } from "../db.ts";
import { AppError, badRequest, requireAdmin } from "../context.ts";
import * as auth from "../services/auth.ts";
import * as ledger from "../services/ledger.ts";
import * as rental from "../services/rental.ts";
import * as reports from "../services/reports.ts";
import * as recurring from "../services/recurring.ts";
import * as cats from "../services/categories.ts";
import { todoSummary } from "../services/todo.ts";
import { createBackup, restoreBackup } from "../services/backup.ts";
import { preparerPackage } from "../services/preparer.ts";
import { annotate, undoAudit } from "../services/undo.ts";
import * as files from "../services/attachments.ts";
import * as library from "../services/files.ts";
import * as manager from "../services/manager-statement.ts";
import * as docs from "../services/manager-documents.ts";
import { transactionsCsv } from "../services/csv.ts";
import { listAudit } from "../services/audit.ts";
import { actorOf, requireAuth, type Env } from "./middleware.ts";

export const api = new Hono<Env>();
api.use("*", requireAuth);

const id = (c: Context) => {
  const n = Number(c.req.param("id"));
  if (!Number.isInteger(n) || n <= 0) throw badRequest("Invalid id");
  return n;
};
const body = async (c: Context) => {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("Expected a JSON body");
  }
};
const queryYear = (c: Context) => {
  const y = Number(c.req.query("year") ?? new Date().getFullYear());
  if (!Number.isInteger(y) || y < 2000 || y > 2100) throw badRequest("Invalid year");
  return y;
};
const queryProperty = (c: Context) => {
  const p = c.req.query("property_id") ?? c.req.query("property");
  return p ? (/^\d+$/.test(p) ? Number(p) : ledger.resolvePropertyId(getDb(), p)) : undefined;
};

// ---------------- overview ----------------

api.get("/overview", (c) => {
  const db = getDb();
  return c.json({
    properties: ledger.listProperties(db),
    categories: ledger.listCategories(db),
    years: reports.availableYears(db),
    schedule_e_lines: ledger.SCHEDULE_E_LINES,
  });
});

// ---------------- properties ----------------

api.get("/properties", (c) => c.json(ledger.listProperties(getDb())));
api.post("/properties", async (c) => c.json(ledger.createProperty(getDb(), actorOf(c), await body(c)), 201));
api.get("/properties/:id", (c) => c.json(ledger.getProperty(getDb(), id(c))));
api.patch("/properties/:id", async (c) => c.json(ledger.updateProperty(getDb(), actorOf(c), id(c), await body(c))));

// ---------------- categories ----------------

api.get("/categories", (c) => c.json(ledger.listCategories(getDb())));
api.post("/categories", async (c) => c.json(ledger.createCategory(getDb(), actorOf(c), await body(c)), 201));
api.patch("/categories/:id", async (c) => c.json(ledger.updateCategory(getDb(), actorOf(c), id(c), await body(c))));
api.delete("/categories/:id", async (c) => {
  // optional body {move_to: category} moves its transactions there first (merge)
  const raw = (await c.req.text()) ? await body(c) : {};
  return c.json(cats.deleteCategoryMoving(getDb(), actorOf(c), id(c), raw));
});
api.get("/categories/tree", (c) => c.json(cats.categoryTree(getDb())));
api.get("/subcategories", (c) => c.json(cats.listSubcategories(getDb())));
api.post("/subcategories", async (c) => c.json(cats.addSubcategory(getDb(), actorOf(c), await body(c)), 201));
api.post("/subcategories/rename", async (c) => c.json(cats.renameSubcategory(getDb(), actorOf(c), await body(c))));
api.post("/subcategories/remove", async (c) => c.json(cats.removeSubcategory(getDb(), actorOf(c), await body(c))));

// ---------------- file library ----------------

const fileFilters = (c: Context) => ({ ...c.req.query(), property_id: queryProperty(c) });
api.get("/files", (c) => c.json(library.listFiles(getDb(), fileFilters(c))));
api.get("/files.zip", (c) => {
  const z = library.filesZip(getDb(), actorOf(c), fileFilters(c));
  return c.body(new Uint8Array(z.data), 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${z.filename}"; filename*=UTF-8''${encodeURIComponent(z.filename)}`,
    "Cache-Control": "no-store",
  });
});

// ---------------- transactions ----------------

api.get("/transactions", (c) => c.json(ledger.listTransactions(getDb(), c.req.query())));
api.post("/transactions", async (c) => {
  const b = await body(c);
  const db = getDb();
  if (Array.isArray(b)) return c.json(ledger.bulkCreate(db, actorOf(c), { transactions: b }), 201);
  return c.json(ledger.createTransaction(db, actorOf(c), b), 201);
});
api.post("/transactions/bulk", async (c) => c.json(ledger.bulkCreate(getDb(), actorOf(c), await body(c))));
api.post("/transactions/bulk-update", async (c) => c.json(ledger.bulkUpdate(getDb(), actorOf(c), await body(c))));
api.post("/transactions/bulk-delete", async (c) => {
  const { ids } = z.object({ ids: z.array(z.number().int()).min(1).max(5000) }).parse(await body(c));
  return c.json(ledger.bulkDelete(getDb(), actorOf(c), ids));
});
api.get("/transactions/:id", (c) => {
  const db = getDb();
  const t = ledger.getTransaction(db, id(c));
  return c.json({ ...t, attachments: files.listAttachments(db, t.id) });
});
api.patch("/transactions/:id", async (c) =>
  c.json(ledger.updateTransaction(getDb(), actorOf(c), id(c), await body(c))),
);
api.delete("/transactions/:id", (c) => c.json(ledger.deleteTransaction(getDb(), actorOf(c), id(c))));
api.post("/transactions/:id/restore", (c) => c.json(ledger.restoreTransaction(getDb(), actorOf(c), id(c))));

api.get("/transactions/:id/attachments", (c) => c.json(files.listAttachments(getDb(), id(c))));
api.post("/transactions/:id/attachments", async (c) => {
  const form = await c.req.formData();
  const uploaded = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!uploaded.length) throw badRequest('Send multipart/form-data with one or more "file" fields');
  const out = [];
  for (const f of uploaded) {
    out.push(
      await files.addAttachment(getDb(), actorOf(c), id(c), {
        filename: f.name,
        contentType: f.type || "application/octet-stream",
        data: new Uint8Array(await f.arrayBuffer()),
      }),
    );
  }
  return c.json(out, 201);
});
api.get("/attachments/:id", async (c) => {
  const { meta, data } = await files.readAttachment(getDb(), id(c));
  const inline = /^(image\/|application\/pdf)/.test(meta.content_type) && c.req.query("download") == null;
  return c.body(new Uint8Array(data), 200, {
    "Content-Type": meta.content_type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${meta.filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "private, max-age=3600",
  });
});
api.patch("/attachments/:id", async (c) =>
  c.json(await files.updateAttachment(getDb(), actorOf(c), id(c), await body(c))),
);
api.post("/attachments/:id/link", async (c) =>
  c.json(files.linkAttachment(getDb(), actorOf(c), id(c), await body(c)), 201),
);
api.delete("/attachments/:id", async (c) => {
  await files.deleteAttachment(getDb(), actorOf(c), id(c));
  return c.json({ ok: true });
});

api.get("/suggestions", (c) => c.json(ledger.suggestions(getDb())));

// ---------------- manager statements + invoices ----------------

const monthParam = (c: Context) => {
  const m = c.req.param("month") ?? "";
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw badRequest("Use YYYY-MM");
  return m;
};
/** Year overview: per month, the saved documents and what still needs doing. */
api.get("/manager/months", (c) =>
  c.json(manager.managerYear(getDb(), { year: queryYear(c), property: queryProperty(c) })),
);
/** Review a month from its saved documents (?subcategory= overrides the manager name). */
api.get("/manager/months/:month", (c) =>
  c.json(
    manager.previewManagerMonth(getDb(), {
      month: monthParam(c),
      property_id: queryProperty(c),
      subcategory: c.req.query("subcategory") || undefined,
    }),
  ),
);
api.post("/manager/months/:month/apply", async (c) =>
  c.json(await docs.applySavedMonth(getDb(), actorOf(c), { ...(await body(c)), month: monthParam(c) })),
);
/** Mark a month's warning as explained ({key, note}), or undo that. */
api.post("/manager/months/:month/explained", async (c) =>
  c.json(
    manager.acknowledgeCheck(getDb(), actorOf(c), {
      ...(await body(c)),
      month: monthParam(c),
      property_id: queryProperty(c),
    }),
  ),
);
api.delete("/manager/months/:month/explained", async (c) =>
  c.json(
    manager.unacknowledgeCheck(getDb(), actorOf(c), {
      ...(await body(c)),
      month: monthParam(c),
      property_id: queryProperty(c),
    }),
  ),
);
/** Upload statements / invoices (multipart, any number of "file" fields). Kind and month are detected. */
api.post("/manager/documents", async (c) => {
  const form = await c.req.formData();
  const uploaded = form.getAll("file").filter((f): f is File => f instanceof File);
  if (!uploaded.length) throw badRequest('Send multipart/form-data with one or more "file" fields');
  const files = await Promise.all(
    uploaded.map(async (f) => ({ filename: f.name, contentType: f.type, data: new Uint8Array(await f.arrayBuffer()) })),
  );
  const month = form.get("month");
  return c.json(
    await docs.saveDocuments(getDb(), actorOf(c), files, {
      property: queryProperty(c),
      replace: form.get("replace") === "true",
      month: typeof month === "string" && month ? month : undefined,
    }),
  );
});
api.get("/manager/documents/:id/file", async (c) => {
  const { meta, data } = await docs.readDocument(getDb(), id(c));
  const inline = meta.content_type === "application/pdf" && c.req.query("download") == null;
  return c.body(new Uint8Array(data), 200, {
    "Content-Type": meta.content_type,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${meta.filename}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    "Cache-Control": "private, max-age=3600",
  });
});
api.patch("/manager/documents/:id", async (c) =>
  c.json(docs.updateDocument(getDb(), actorOf(c), id(c), await body(c))),
);
api.delete("/manager/documents/:id", async (c) => c.json(await docs.deleteDocument(getDb(), actorOf(c), id(c))));

// ---------------- occupancy & tax inputs ----------------

api.get("/occupancy", (c) =>
  c.json(
    rental.listOccupancy(getDb(), {
      year: c.req.query("year") ? queryYear(c) : undefined,
      property_id: queryProperty(c),
    }),
  ),
);
api.put("/occupancy", async (c) => {
  const b = await body(c);
  const db = getDb();
  if (Array.isArray(b)) return c.json(b.map((row) => rental.upsertOccupancy(db, actorOf(c), row)));
  return c.json(rental.upsertOccupancy(db, actorOf(c), b));
});
api.delete("/occupancy/:id", (c) => {
  rental.deleteOccupancy(getDb(), actorOf(c), id(c));
  return c.json({ ok: true });
});

api.get("/tax-years/:year", (c) => {
  const db = getDb();
  return c.json(rental.getTaxYear(db, ledger.resolvePropertyId(db, queryProperty(c)), Number(c.req.param("year"))));
});
api.put("/tax-years/:year", async (c) =>
  c.json(rental.setTaxYear(getDb(), actorOf(c), { ...(await body(c)), year: Number(c.req.param("year")) })),
);

// ---------------- reports & exports ----------------

api.get("/reports/summary", (c) => c.json(reports.summary(getDb(), queryYear(c), queryProperty(c))));
api.get("/reports/month", (c) =>
  c.json(reports.monthDetail(getDb(), recurring.assertMonth(c.req.query("month")), queryProperty(c))),
);
api.get("/reports/years", (c) => c.json(reports.yearTotals(getDb(), queryProperty(c))));
api.get("/reports/categories", (c) => c.json(reports.categoryMonths(getDb(), queryYear(c), queryProperty(c))));
api.get("/todo", (c) => c.json(todoSummary(getDb(), { propertyId: queryProperty(c) })));
api.get("/recurring", (c) => c.json(recurring.recurring(getDb(), { propertyId: queryProperty(c) })));
api.post("/recurring/dismissals", async (c) => c.json(recurring.dismiss(getDb(), actorOf(c), await body(c)), 201));
api.delete("/recurring/dismissals/:id", (c) => c.json(recurring.undismiss(getDb(), actorOf(c), id(c))));
api.get("/reports/tax", (c) => c.json(reports.taxReport(getDb(), queryYear(c), queryProperty(c))));

api.get("/reports/tax.csv", (c) => {
  const r = reports.taxReport(getDb(), queryYear(c), queryProperty(c));
  return csvResponse(c, reports.taxReportCsv(r), `tax-report-${r.year}.csv`);
});

// Everything for the tax preparer for one year: summary, tax CSV, transactions CSV, receipts.
api.get("/reports/tax-package.zip", (c) => {
  const p = preparerPackage(getDb(), actorOf(c), queryYear(c), queryProperty(c));
  return c.body(new Uint8Array(p.data), 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${p.filename}"; filename*=UTF-8''${encodeURIComponent(p.filename)}`,
    "Cache-Control": "no-store",
  });
});

api.get("/export/transactions.csv", (c) => {
  const q = { ...c.req.query(), limit: "5000" };
  const { items } = ledger.listTransactions(getDb(), q);
  return csvResponse(
    c,
    transactionsCsv(items),
    `transactions${c.req.query("year") ? "-" + c.req.query("year") : ""}.csv`,
  );
});

// Full backup (admin): database snapshot + receipts as a zip.
api.get("/backup", (c) => {
  const b = createBackup(getDb(), actorOf(c));
  return c.body(new Uint8Array(b.data), 200, {
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="${b.filename}"`,
    "Cache-Control": "no-store",
  });
});

// Restore (admin): replace all data with a backup zip sent as the raw request body.
api.post("/backup/restore", async (c) => {
  const actor = actorOf(c);
  requireAdmin(actor); // before reading a large body
  const data = Buffer.from(await c.req.arrayBuffer());
  if (!data.length) throw badRequest("Send the backup .zip as the request body");
  return c.json(restoreBackup(getDb(), actor, data, sourceName(c.req.header("x-filename"))));
});

const sourceName = (h: string | undefined) => {
  try {
    return h ? decodeURIComponent(h).slice(0, 200) : "upload";
  } catch {
    return "upload";
  }
};

function csvResponse(c: Context, csv: string, filename: string) {
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

// ---------------- audit ----------------

api.get("/audit", (c) => {
  const q = z
    .object({
      entity: z.string().optional(),
      entity_id: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
      offset: z.coerce.number().int().min(0).default(0),
      hide_logins: z.preprocess((v) => v === "true", z.boolean()).optional(),
    })
    .parse(c.req.query());
  const db = getDb();
  return c.json(annotate(db, listAudit(db, q)));
});
api.post("/audit/:id/undo", (c) => c.json(undoAudit(getDb(), actorOf(c), id(c))));

// ---------------- API keys & users ----------------

api.get("/api-keys", (c) => c.json(auth.listApiKeys(getDb(), actorOf(c))));
api.post("/api-keys", async (c) =>
  c.json(auth.createApiKey(getDb(), actorOf(c), auth.apiKeyInput.parse(await body(c))), 201),
);
api.delete("/api-keys/:id", (c) => {
  auth.revokeApiKey(getDb(), actorOf(c), id(c));
  return c.json({ ok: true });
});

api.get("/users", (c) => c.json(auth.listUsers(getDb(), actorOf(c))));
api.post("/users", async (c) => {
  const actor = actorOf(c);
  requireAdmin(actor);
  if (actor.apiKeyId) throw new AppError(403, "Manage users from a browser session");
  return c.json(await auth.createUser(getDb(), actor, auth.userCreateInput.parse(await body(c))), 201);
});
api.patch("/users/:id", async (c) => {
  const actor = actorOf(c);
  if (actor.apiKeyId) throw new AppError(403, "Manage users from a browser session");
  return c.json(await auth.updateUser(getDb(), actor, id(c), auth.userUpdateInput.parse(await body(c))));
});
