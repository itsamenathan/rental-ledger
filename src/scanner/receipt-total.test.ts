import { describe, expect, it } from "vite-plus/test";
import { findDate, findTotal, readReceipt } from "./receipt-total.ts";

const TODAY = "2026-11-19";

describe("findTotal", () => {
  it("reads the TOTAL line, not the subtotal, tax or change", () => {
    const text = `
      HARBOR HARDWARE
      123 Main St
      Paint roller        12.99
      Drop cloth           8.49
      SUBTOTAL            21.48
      SALES TAX 6%         1.29
      TOTAL               22.77
      CASH                40.00
      CHANGE              17.23
    `;
    expect(findTotal(text)).toEqual({ total: 22.77, labelled: true });
  });

  it("prefers the later total after a tip", () => {
    const text = "Subtotal 40.00\nTotal 40.00\nTip 8.00\nTotal 48.00\nVISA 48.00";
    expect(findTotal(text)?.total).toBe(48);
  });

  it("ranks AMOUNT DUE over a card line", () => {
    expect(findTotal("Amount Due $1,234.56\nVisa ****1234 $1,234.56\nThank you")?.total).toBe(1234.56);
  });

  it("keeps a total that says it includes tax", () => {
    expect(findTotal("Items 3\nTOTAL INCL. TAX 45.10\nTax included 4.10")?.total).toBe(45.1);
  });

  it("ignores a zero balance after payment", () => {
    expect(findTotal("Invoice Total 120.00\nAmount Paid 120.00\nBalance Due 0.00")?.total).toBe(120);
  });

  it("trusts the amount that adds up when OCR misreads the TOTAL line", () => {
    const text = "SUBTOTAL 43.51\nSALES TAX 5.5% 2.39\nTOTAL 45.99\nVISA ****4421 45.90";
    expect(findTotal(text)?.total).toBe(45.9);
  });

  it("uses subtotal + tax when every total line has the same misread digit", () => {
    const text = "SUBTOTAL 43.51\nSALES TAX 5.5% 2.39\nTOTAL 45.99\nVISA EERRL42]1 45.99";
    expect(findTotal(text)?.total).toBe(45.9);
  });

  it("keeps a total that differs from subtotal + tax by more than a misread (fees, discounts)", () => {
    expect(findTotal("Subtotal 100.00\nTax 8.00\nService fee 15.00\nTotal 123.00")?.total).toBe(123);
  });

  it("adds the tip when checking the sum", () => {
    expect(findTotal("Subtotal 36.00\nTax 4.00\nTotal 40.00\nTip 8.00\nTotal 48.00")?.total).toBe(48);
  });

  it("copes with OCR noise", () => {
    expect(findTotal("T0TAL $ 19. 99")?.total).toBe(19.99);
    expect(findTotal("TOTA1      7,50")?.total).toBe(7.5);
  });

  it("takes the amount from the next line when the column split", () => {
    expect(findTotal("TOTAL\n$63.20\nThank you for shopping")?.total).toBe(63.2);
  });

  it("falls back to the largest amount when nothing is labelled", () => {
    expect(findTotal("Coffee 4.50\nMuffin 3.25\n7.75\nCash 10.00\nChange 2.25")).toEqual({
      total: 7.75,
      labelled: false,
    });
  });

  it("gives up on text without amounts", () => {
    expect(findTotal("Thank you!\nCall 555-1234")).toBeNull();
  });
});

describe("findDate", () => {
  it("reads US numeric dates", () => {
    expect(findDate("Date: 11/03/2026 14:22", TODAY)).toBe("2026-11-03");
    expect(findDate("11-03-26", TODAY)).toBe("2026-11-03");
  });

  it("reads ISO and written dates", () => {
    expect(findDate("2026-10-31 09:00", TODAY)).toBe("2026-10-31");
    expect(findDate("Nov 2, 2026", TODAY)).toBe("2026-11-02");
    expect(findDate("2 November 2026", TODAY)).toBe("2026-11-02");
  });

  it("skips return-by dates in the future and impossible dates", () => {
    expect(findDate("Return by 02/17/2027\nSold 11/18/2026", TODAY)).toBe("2026-11-18");
    expect(findDate("02/30/2026", TODAY)).toBeNull();
    expect(findDate("01/05/2020", TODAY)).toBeNull();
  });
});

describe("readReceipt", () => {
  it("combines both", () => {
    expect(readReceipt("Store\n11/18/26\nTOTAL 22.77", TODAY)).toEqual({
      total: 22.77,
      labelled: true,
      date: "2026-11-18",
    });
  });
});
