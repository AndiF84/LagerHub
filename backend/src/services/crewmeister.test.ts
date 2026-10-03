import { describe, expect, it } from "vitest";
import { isoDurationToMinutes } from "./crewmeister.js";

// Crewmeister liefert Dauern als ISO-8601 ("PT8H", "PT2H43M55S"). Der Parser ist
// reine Logik und die Grundlage für die echte Arbeitszeit in der Auswertung.
describe("isoDurationToMinutes", () => {
  it("volle Stunden", () => {
    expect(isoDurationToMinutes("PT8H")).toBe(480);
  });

  it("Stunden + Minuten", () => {
    expect(isoDurationToMinutes("PT3H30M")).toBe(210);
  });

  it("nur Minuten", () => {
    expect(isoDurationToMinutes("PT30M")).toBe(30);
  });

  it("Stunden + Minuten + Sekunden (Sekunden anteilig)", () => {
    expect(isoDurationToMinutes("PT2H43M55S")).toBeCloseTo(163 + 55 / 60, 5);
  });

  it("negative Diff-Dauern vorzeichenrichtig", () => {
    expect(isoDurationToMinutes("PT-3H")).toBe(-180);
  });

  it("ungültiges Format -> 0", () => {
    expect(isoDurationToMinutes("garbage")).toBe(0);
  });
});
