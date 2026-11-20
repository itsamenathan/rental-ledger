/** Scanned pages → the file attached to the entry: one page is a JPEG, several are one PDF. */

export interface ScannedPage {
  jpeg: Blob;
  width: number;
  height: number;
}

/** PDF pages are US Letter wide; the height follows the page (long receipts make tall pages). */
const PDF_WIDTH_PT = 612;

export async function pagesToFile(pages: ScannedPage[], day: string): Promise<File> {
  if (pages.length === 1) return new File([pages[0]!.jpeg], `scan-${day}.jpg`, { type: "image/jpeg" });
  // Loaded only for a multi-page scan, so opening the scanner doesn't wait for it.
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Scan ${day}`);
  pdf.setProducer("Rental ledger scanner");
  for (const p of pages) {
    const image = await pdf.embedJpg(new Uint8Array(await p.jpeg.arrayBuffer()));
    const page = pdf.addPage([PDF_WIDTH_PT, (PDF_WIDTH_PT * p.height) / p.width]);
    page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  }
  const bytes = await pdf.save();
  return new File([bytes as Uint8Array<ArrayBuffer>], `scan-${day}.pdf`, { type: "application/pdf" });
}
