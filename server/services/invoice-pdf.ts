import { badRequest } from "../context.ts";
import { log } from "../telemetry.ts";

/** Text extraction for manager invoice PDFs. unpdf is imported lazily so server startup stays fast. */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  let lib: typeof import("unpdf");
  try {
    lib = await import("unpdf");
  } catch (err) {
    log.error({ err }, "PDF support (unpdf) could not be loaded");
    throw badRequest("PDF reading isn't installed on this server (the unpdf package is missing; run `vp install`)");
  }
  try {
    const pdf = await lib.getDocumentProxy(new Uint8Array(data));
    const { text } = await lib.extractText(pdf, { mergePages: false });
    // Line items can span pages, so hand the parser one continuous text.
    return (Array.isArray(text) ? text : [text]).join("\n");
  } catch (err) {
    log.warn({ err }, "Couldn't read text from an invoice PDF");
    throw badRequest("Couldn't read text from that PDF (is it a scan? Try a text/printed-to-PDF invoice)");
  }
}
