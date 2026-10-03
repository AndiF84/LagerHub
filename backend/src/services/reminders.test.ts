// Terminrechnung der Erinnerungen. Schwerpunkt liegt auf den Fällen, in denen
// eine naive Datumsrechnung falsch liegt: Monatsende, "heute ist schon der
// Wochentag", überfällige Erinnerungen.
import { describe, it, expect } from "vitest";
import {
  computeNextDue,
  postponeDate,
  startOfLocalDay,
  MAX_POSTPONE_DAYS,
  type RepeatSpec,
} from "./reminders.js";

const spec = (over: Partial<RepeatSpec>): RepeatSpec => ({
  repeatRule: "NONE",
  intervalDays: null,
  weekday: null,
  dayOfMonth: null,
  ...over,
});

const tag = (iso: string) => new Date(`${iso}T09:30:00`);
const key = (d: Date | null) =>
  d === null
    ? null
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

describe("computeNextDue", () => {
  it("einmalige Erinnerung hat keinen Folgetermin", () => {
    expect(computeNextDue(spec({ repeatRule: "NONE" }), tag("2026-09-03"))).toBeNull();
  });

  it("täglich → morgen", () => {
    expect(key(computeNextDue(spec({ repeatRule: "DAILY" }), tag("2026-09-03")))).toBe("2026-09-04");
  });

  it("täglich über den Monatswechsel", () => {
    expect(key(computeNextDue(spec({ repeatRule: "DAILY" }), tag("2026-09-30")))).toBe("2026-10-01");
  });

  it("Intervall zählt ab dem Entscheidungstag, nicht ab der alten Fälligkeit", () => {
    // Genau das ist der Punkt: eine 3 Wochen liegengebliebene Erinnerung soll
    // nicht mehrfach rückwirkend fällig werden.
    const next = computeNextDue(spec({ repeatRule: "INTERVAL", intervalDays: 14 }), tag("2026-09-03"));
    expect(key(next)).toBe("2026-09-17");
  });

  it("Intervall ohne brauchbaren Wert fällt auf morgen zurück (statt zu verschwinden)", () => {
    expect(key(computeNextDue(spec({ repeatRule: "INTERVAL", intervalDays: 0 }), tag("2026-09-03")))).toBe(
      "2026-09-04",
    );
    expect(key(computeNextDue(spec({ repeatRule: "INTERVAL", intervalDays: null }), tag("2026-09-03")))).toBe(
      "2026-09-04",
    );
  });

  it("wöchentlich → der nächste passende Wochentag", () => {
    // 2026-09-03 ist ein Donnerstag (getDay 4); Ziel Montag (1) → 2026-09-07.
    expect(tag("2026-09-03").getDay()).toBe(4);
    expect(key(computeNextDue(spec({ repeatRule: "WEEKLY", weekday: 1 }), tag("2026-09-03")))).toBe(
      "2026-09-07",
    );
  });

  it("wöchentlich am HEUTIGEN Wochentag springt eine ganze Woche weiter", () => {
    // Sonst wäre die Erinnerung sofort wieder fällig und stünde direkt nach dem
    // Abhaken erneut im Banner.
    expect(key(computeNextDue(spec({ repeatRule: "WEEKLY", weekday: 4 }), tag("2026-09-03")))).toBe(
      "2026-09-10",
    );
  });

  it("monatlich → gleicher Tag im Folgemonat", () => {
    expect(key(computeNextDue(spec({ repeatRule: "MONTHLY", dayOfMonth: 15 }), tag("2026-09-03")))).toBe(
      "2026-10-15",
    );
  });

  it("monatlich am 31. wird auf den Monatsletzten gekappt (kein Übersprung in den Folgemonat)", () => {
    // Januar → Februar 2026 (28 Tage): naive Arithmetik landet auf dem 3. März.
    expect(key(computeNextDue(spec({ repeatRule: "MONTHLY", dayOfMonth: 31 }), tag("2026-01-15")))).toBe(
      "2026-02-28",
    );
  });

  it("monatlich am 31. im Schaltjahr-Februar", () => {
    expect(key(computeNextDue(spec({ repeatRule: "MONTHLY", dayOfMonth: 31 }), tag("2028-01-10")))).toBe(
      "2028-02-29",
    );
  });

  it("monatlich über den Jahreswechsel", () => {
    expect(key(computeNextDue(spec({ repeatRule: "MONTHLY", dayOfMonth: 5 }), tag("2026-12-20")))).toBe(
      "2027-01-05",
    );
  });

  it("liefert immer lokale Mitternacht (Uhrzeit der Entscheidung spielt keine Rolle)", () => {
    const spaet = new Date("2026-09-03T23:59:00");
    const next = computeNextDue(spec({ repeatRule: "DAILY" }), spaet);
    expect(next?.getHours()).toBe(0);
    expect(next?.getMinutes()).toBe(0);
    expect(key(next)).toBe("2026-09-04");
  });
});

describe("postponeDate", () => {
  it("verschiebt um die gewünschten Tage ab heute", () => {
    expect(key(postponeDate(3, tag("2026-09-03")))).toBe("2026-09-06");
  });

  it("kappt bei 7 Tagen und bei mindestens 1 Tag", () => {
    expect(key(postponeDate(99, tag("2026-09-03")))).toBe("2026-09-10");
    expect(key(postponeDate(0, tag("2026-09-03")))).toBe("2026-09-04");
    expect(key(postponeDate(-5, tag("2026-09-03")))).toBe("2026-09-04");
    expect(MAX_POSTPONE_DAYS).toBe(7);
  });

  it("liefert lokale Mitternacht", () => {
    expect(postponeDate(2, tag("2026-09-03")).getHours()).toBe(0);
  });
});

describe("startOfLocalDay", () => {
  it("schneidet die Uhrzeit ab, ohne den Tag zu verschieben", () => {
    const d = startOfLocalDay(new Date("2026-09-03T23:59:59"));
    expect(key(d)).toBe("2026-09-03");
    expect(d.getHours()).toBe(0);
  });
});
