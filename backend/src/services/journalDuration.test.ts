import { describe, expect, it } from "vitest";
import { stepDurationMinutes } from "./journalDuration.js";

const t = (hhmm: string) => `2026-10-01T${hhmm}:00.000Z`;
const MIN = 60_000;

describe("stepDurationMinutes – Dauer eines Schritts im Tagesjournal", () => {
  it("ein MA ohne Unterbrechung: Ende − Start", () => {
    expect(stepDurationMinutes([{ startedAt: t("08:00"), finishedAt: t("08:25"), pausedMs: 0 }])).toBe(25);
  });

  it("ein MA mit Unterbrechung über Nacht: nur die Netto-Zeit", () => {
    // 08:00–09:00 am nächsten Tag, davon 23 h unterbrochen ⇒ 60 min Arbeit.
    expect(
      stepDurationMinutes([
        { startedAt: t("08:00"), finishedAt: "2026-10-02T09:00:00.000Z", pausedMs: 24 * 60 * MIN },
      ]),
    ).toBe(60);
  });

  it("Team: drei MA gleichzeitig zählen EINMAL, nicht dreifach", () => {
    const a = { startedAt: t("08:00"), finishedAt: t("08:20"), pausedMs: 0 };
    expect(stepDurationMinutes([a, a, a])).toBe(20);
  });

  it("Team: Wartezeit vor dem Timer-Start zählt nicht", () => {
    // A loggt sich 07:30 ein, B erst 08:00 – der Schritt läuft ab 08:00.
    expect(
      stepDurationMinutes(
        [
          { startedAt: t("07:30"), finishedAt: t("08:30"), pausedMs: 0 },
          { startedAt: t("08:00"), finishedAt: t("08:30"), pausedMs: 0 },
        ],
        t("08:00"),
      ),
    ).toBe(30);
  });

  it("ohne Timer-Start im Snapshot (alte Läufe) zählt ab dem Einloggen", () => {
    expect(
      stepDurationMinutes([
        { startedAt: t("07:30"), finishedAt: t("08:30"), pausedMs: 0 },
        { startedAt: t("08:00"), finishedAt: t("08:30"), pausedMs: 0 },
      ]),
    ).toBe(60);
  });

  it("Übernahme: A unterbricht, B übernimmt und schließt – beide Abschnitte addiert", () => {
    // A 08:00–08:30 gearbeitet, dann unterbrochen bis zum Abschluss um 09:00.
    expect(
      stepDurationMinutes([
        { startedAt: t("08:00"), finishedAt: t("09:00"), pausedMs: 30 * MIN },
        { startedAt: t("08:30"), finishedAt: t("09:00"), pausedMs: 0 },
      ]),
    ).toBe(60);
  });

  it("getrennte Abschnitte: Lücke dazwischen zählt nicht", () => {
    expect(
      stepDurationMinutes([
        { startedAt: t("08:00"), finishedAt: t("08:10"), pausedMs: 0 },
        { startedAt: t("10:00"), finishedAt: t("10:15"), pausedMs: 0 },
      ]),
    ).toBe(25);
  });

  it("abgelehnte/offene Angebote (ohne Ende) werden ignoriert", () => {
    expect(
      stepDurationMinutes([
        { startedAt: t("08:00"), finishedAt: null },
        { startedAt: t("08:00"), finishedAt: t("08:12"), pausedMs: 0 },
      ]),
    ).toBe(12);
  });

  it("ohne auswertbare Zeiten: null (Anzeige „–“), nicht 0", () => {
    expect(stepDurationMinutes([])).toBeNull();
    expect(stepDurationMinutes([{ startedAt: t("08:00"), finishedAt: null }])).toBeNull();
  });

  it("Unterbrechung länger als die Spanne (Datenfehler) wird nicht negativ", () => {
    expect(stepDurationMinutes([{ startedAt: t("08:00"), finishedAt: t("08:10"), pausedMs: 60 * MIN }])).toBe(0);
  });
});
