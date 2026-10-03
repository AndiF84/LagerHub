import { describe, expect, it } from "vitest";
import { isWithinQuietPeriod } from "./quietHours.js";

// Zeitpunkt am selben (beliebigen) Tag zur Uhrzeit hh:mm – geprüft wird
// ausschließlich die Tageszeit, das Datum ist egal.
const at = (h: number, m: number) => new Date(2026, 7, 30, h, m, 0, 0);

// Standard-Pause, wie sie per Default in den Settings steht.
const MITTAG = { breakStart: "12:00", breakEnd: "12:30" };

describe("isWithinQuietPeriod – innerhalb der Pause", () => {
  it("schweigt zwischen Beginn und Ende", () => {
    expect(isWithinQuietPeriod(MITTAG, at(12, 0))).toBe(true);
    expect(isWithinQuietPeriod(MITTAG, at(12, 15))).toBe(true);
    expect(isWithinQuietPeriod(MITTAG, at(12, 29))).toBe(true);
  });

  it("ignoriert Sekunden und Millisekunden (12:29:59 ist noch Pause)", () => {
    expect(isWithinQuietPeriod(MITTAG, new Date(2026, 7, 30, 12, 29, 59, 999))).toBe(true);
  });
});

// Grenzen: Beginn EINschließlich, Ende AUSschließlich – gleiche Konvention wie
// isWithinWorkHours im Scheduler. Genau hier sitzt der typische Off-by-one.
describe("isWithinQuietPeriod – Grenzminuten", () => {
  it("beginnt exakt zur Startminute (einschließlich)", () => {
    expect(isWithinQuietPeriod(MITTAG, at(11, 59))).toBe(false);
    expect(isWithinQuietPeriod(MITTAG, at(12, 0))).toBe(true);
  });

  it("endet exakt zur Endminute (ausschließlich) – 12:30 eskaliert wieder", () => {
    expect(isWithinQuietPeriod(MITTAG, at(12, 29))).toBe(true);
    expect(isWithinQuietPeriod(MITTAG, at(12, 30))).toBe(false);
  });

  it("lässt Zeiten außerhalb der Pause durch", () => {
    for (const [h, m] of [[8, 0], [11, 0], [13, 0], [16, 59]] as const) {
      expect(isWithinQuietPeriod(MITTAG, at(h, m))).toBe(false);
    }
  });
});

describe("isWithinQuietPeriod – frei konfigurierte Zeiten", () => {
  it("folgt geänderten Werten aus den Settings", () => {
    const spaet = { breakStart: "13:00", breakEnd: "14:00" };
    expect(isWithinQuietPeriod(spaet, at(12, 15))).toBe(false);
    expect(isWithinQuietPeriod(spaet, at(13, 30))).toBe(true);
  });

  it("kommt mit einer Minute Pause zurecht", () => {
    const kurz = { breakStart: "12:00", breakEnd: "12:01" };
    expect(isWithinQuietPeriod(kurz, at(12, 0))).toBe(true);
    expect(isWithinQuietPeriod(kurz, at(12, 1))).toBe(false);
  });
});

// „Keine Pause" muss heißen: der Alarm läuft durch. Ein stiller Dauerausfall der
// Eskalation wäre der teurere Fehler – lieber einmal zu viel melden.
describe("isWithinQuietPeriod – deaktiviert und Schrott-Werte", () => {
  it("gleiche Zeiten = Pause deaktiviert", () => {
    const aus = { breakStart: "12:00", breakEnd: "12:00" };
    expect(isWithinQuietPeriod(aus, at(12, 0))).toBe(false);
    expect(isWithinQuietPeriod(aus, at(11, 59))).toBe(false);
  });

  it("Ende vor Beginn schweigt NICHT (kein Dauerausfall durch Altbestand)", () => {
    const verdreht = { breakStart: "13:00", breakEnd: "12:00" };
    for (const [h, m] of [[11, 0], [12, 30], [13, 30], [23, 59]] as const) {
      expect(isWithinQuietPeriod(verdreht, at(h, m))).toBe(false);
    }
  });

  it("unparsbare oder fehlende Werte gelten als deaktiviert", () => {
    const kaputt = [
      { breakStart: "", breakEnd: "" },
      { breakStart: "12", breakEnd: "12:30" },
      { breakStart: "25:00", breakEnd: "26:00" },
      { breakStart: "12:60", breakEnd: "12:70" },
      { breakStart: "Mittag", breakEnd: "Ende" },
      undefined as never,
    ];
    for (const p of kaputt) {
      expect(isWithinQuietPeriod(p, at(12, 15))).toBe(false);
    }
  });

  it("akzeptiert auch einstellige Stunden (9:00)", () => {
    const frueh = { breakStart: "9:00", breakEnd: "9:15" };
    expect(isWithinQuietPeriod(frueh, at(9, 5))).toBe(true);
    expect(isWithinQuietPeriod(frueh, at(9, 15))).toBe(false);
  });

  it("nutzt ohne Zeitangabe die aktuelle Uhrzeit", () => {
    expect(typeof isWithinQuietPeriod(MITTAG)).toBe("boolean");
  });
});
