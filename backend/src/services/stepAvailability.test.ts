import { beforeEach, describe, expect, it, vi } from "vitest";

// db.js mocken, bevor stepAvailability.js/stepStatus.js es importieren
// (vi.mock wird hochgezogen). Gelesen wird nur step.findMany, geschrieben nur
// step.updateMany – das genügt als Mock.
vi.mock("../db.js", () => ({
  prisma: { step: { findMany: vi.fn(), updateMany: vi.fn() } },
}));

import { prisma } from "../db.js";
import { clearAvailability, markAvailableSteps, markStepAvailable } from "./stepAvailability.js";

const findMany = prisma.step.findMany as unknown as ReturnType<typeof vi.fn>;
const updateMany = prisma.step.updateMany as unknown as ReturnType<typeof vi.fn>;

// Baut einen Schritt in der Form, die markAvailableSteps liest
// (id + availableAt + die Felder aus stepStatusSelect).
const step = (
  id: string,
  availableAt: Date | null,
  assignments: { state: string }[] = [],
  predecessors: { minWorkers: number | null; assignments: { state: string }[] }[] = [],
) => ({
  id,
  availableAt,
  minWorkers: null,
  startedAt: null,
  assignments,
  predecessors: predecessors.map((p) => ({ predecessor: p })),
});

beforeEach(() => {
  findMany.mockReset();
  updateMany.mockReset();
});

describe("markAvailableSteps", () => {
  it("stempelt einen offenen Schritt ohne Zeitpunkt", async () => {
    findMany.mockResolvedValueOnce([step("s1", null)]);

    await expect(markAvailableSteps("task-1")).resolves.toBe(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: { in: ["s1"] } });
    expect(arg.data.availableAt).toBeInstanceOf(Date);
  });

  // Kernregel: nie überschreiben. Sonst würde jedes erneute Einstellen in den
  // Pool die Wartezeit auf 0 zurücksetzen und Liegenbleiber unsichtbar machen.
  it("lässt einen bereits gestempelten Schritt unangetastet (idempotent)", async () => {
    findMany.mockResolvedValueOnce([step("s1", new Date("2026-08-08T07:00:00Z"))]);

    await expect(markAvailableSteps("task-1")).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  // Ein gesperrter Schritt darf keinen Zeitpunkt bekommen – er wäre älter als
  // seine eigene Freigabe und erschiene später mit überhöhtem Alter.
  it("überspringt gesperrte Schritte (Vorgänger noch nicht erledigt)", async () => {
    findMany.mockResolvedValueOnce([
      step("gesperrt", null, [], [{ minWorkers: null, assignments: [{ state: "ACTIVE" }] }]),
    ]);

    await expect(markAvailableSteps("task-1")).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("stempelt einen Schritt, dessen Vorgänger fertig sind", async () => {
    findMany.mockResolvedValueOnce([
      step("frei", null, [], [{ minWorkers: null, assignments: [{ state: "DONE" }] }]),
    ]);

    await expect(markAvailableSteps("task-1")).resolves.toBe(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["frei"] } });
  });

  // Bereits bearbeitete Schritte sind nicht mehr OPEN – ihre Wartezeit ist
  // vorbei, ein nachträglicher Stempel wäre falsch.
  it("überspringt Schritte, an denen schon gearbeitet wird", async () => {
    findMany.mockResolvedValueOnce([step("laeuft", null, [{ state: "ACTIVE" }])]);

    await expect(markAvailableSteps("task-1")).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("stempelt mehrere offene Schritte in EINEM updateMany", async () => {
    findMany.mockResolvedValueOnce([step("a", null), step("b", null)]);

    await expect(markAvailableSteps("task-1")).resolves.toBe(2);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: { in: ["a", "b"] } });
  });
});

describe("markStepAvailable", () => {
  // Der null-Guard steckt hier in der WHERE-Bedingung (statt in JS), damit der
  // Aufruf aus handleStepUnlocks auch bei mehrfachem Durchlauf des
  // Abschluss-Pfads den ERSTEN Zeitpunkt behält.
  it("schreibt nur, solange noch kein Zeitpunkt gesetzt ist", async () => {
    await markStepAvailable("s1");

    const arg = updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: "s1", availableAt: null });
    expect(arg.data.availableAt).toBeInstanceOf(Date);
  });
});

describe("clearAvailability", () => {
  it("setzt alle Schritte der Aufgabe zurück", async () => {
    await clearAvailability("task-1");

    expect(updateMany).toHaveBeenCalledWith({
      where: { taskId: "task-1" },
      data: { availableAt: null },
    });
  });
});
