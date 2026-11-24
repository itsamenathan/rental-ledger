import { describe, expect, it } from "vite-plus/test";
import { monthWeeks, weekdayNames } from "./calendar.ts";

// December 2026 starts on a Tuesday and ends on a Thursday.
describe("monthWeeks", () => {
  it("starts on Sunday by default layout", () => {
    const w = monthWeeks("2026-12", 0);
    expect(w[0]![0]).toBe("2026-11-29");
    expect(w.at(-1)!.at(-1)).toBe("2027-01-02");
    expect(w).toHaveLength(5);
  });

  it("starts on Monday", () => {
    const w = monthWeeks("2026-12", 1);
    expect(w[0]![0]).toBe("2026-11-30");
    expect(w.at(-1)!.at(-1)).toBe("2027-01-03");
  });

  it("starts on Saturday", () => {
    const w = monthWeeks("2026-12", 6);
    expect(w[0]![0]).toBe("2026-11-28");
    expect(w.at(-1)!.at(-1)).toBe("2027-01-01");
  });

  it("has no lead days when the 1st is the first day of the week, and six when it is the day before", () => {
    // 2026-11-01 is a Sunday
    expect(monthWeeks("2026-11", 0)[0]![0]).toBe("2026-11-01");
    expect(monthWeeks("2026-11", 1)[0]![0]).toBe("2026-10-26");
  });

  it("covers every day of the month once, in rows of seven, across a leap February", () => {
    for (const ws of [0, 1, 6]) {
      const days = monthWeeks("2028-02", ws).flat();
      expect(days.length % 7).toBe(0);
      expect(new Set(days).size).toBe(days.length);
      expect(days.filter((d) => d.startsWith("2028-02"))).toHaveLength(29);
    }
  });
});

describe("weekdayNames", () => {
  it("rotates the headers to the chosen first day", () => {
    expect(weekdayNames(0)).toEqual(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
    expect(weekdayNames(1)[0]).toBe("Mon");
    expect(weekdayNames(1)[6]).toBe("Sun");
    expect(weekdayNames(6)[0]).toBe("Sat");
  });
});
