// Anwesenheits-Sync: was beim WECHSEL des Stempelstatus passiert.
//
// Der Kern ist zeitkritisch und im Betrieb kaum von Hand prüfbar (man müsste sich
// bei Crewmeister aus- und wieder einstempeln), deshalb hier gegen Mocks:
// Ausstempeln muss die laufende Arbeit unterbrechen (sonst läuft die Uhr über
// Nacht weiter), Einstempeln muss an die unterbrochenen Schritte erinnern.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({
  prisma: {
    employee: { findMany: vi.fn(), update: vi.fn() },
    assignment: { findMany: vi.fn(), updateMany: vi.fn() },
  },
}));
vi.mock("../events.js", () => ({ publish: vi.fn() }));
vi.mock("../routes/assignments.js", () => ({
  afterAssignmentChange: vi.fn(),
  remindOwnInterruptedSteps: vi.fn(),
}));
vi.mock("./crewmeister.js", () => ({
  crewmeisterConfigured: vi.fn(() => true),
  getPresentUserIds: vi.fn(),
  CrewmeisterError: class CrewmeisterError extends Error {},
}));

import { prisma } from "../db.js";
import { afterAssignmentChange, remindOwnInterruptedSteps } from "../routes/assignments.js";
import { getPresentUserIds } from "./crewmeister.js";
import { handlePresenceTransition, syncCrewmeisterPresence } from "./presence.js";

const fn = (f: unknown) => f as ReturnType<typeof vi.fn>;
const employeeFindMany = fn(prisma.employee.findMany);
const employeeUpdate = fn(prisma.employee.update);
const assignmentFindMany = fn(prisma.assignment.findMany);
const assignmentUpdateMany = fn(prisma.assignment.updateMany);
const presentIds = fn(getPresentUserIds);
const afterChange = fn(afterAssignmentChange);
const remind = fn(remindOwnInterruptedSteps);

// Ein MA im Auto-Modus, wie ihn presence.ts aus der DB liest.
const employee = (id: string, present: boolean, crewmeisterUserId = 1) => ({
  id,
  present,
  crewmeisterUserId,
});

// Eine laufende Zuweisung in der von presence.ts selektierten Form.
const running = (id: string, stepId = "step-1", taskId = "task-1") => ({
  id,
  stepId,
  step: { taskId },
});

beforeEach(() => {
  vi.clearAllMocks();
  presentIds.mockResolvedValue(new Set<number>());
  employeeFindMany.mockResolvedValue([]);
  assignmentFindMany.mockResolvedValue([]);
});

describe("syncCrewmeisterPresence – Ausstempeln", () => {
  it("unterbricht die laufenden Zuweisungen und stoppt damit die Uhr", async () => {
    employeeFindMany.mockResolvedValue([employee("ma-1", true)]);
    presentIds.mockResolvedValue(new Set()); // nicht mehr eingestempelt
    assignmentFindMany.mockResolvedValue([running("a-1")]);

    await syncCrewmeisterPresence();

    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: "ma-1" },
      data: { present: false },
    });
    expect(assignmentUpdateMany).toHaveBeenCalledTimes(1);
    const { where, data } = assignmentUpdateMany.mock.calls[0][0];
    expect(where).toEqual({ id: { in: ["a-1"] } });
    expect(data.state).toBe("PAUSED");
    expect(data.pausedReason).toBe("END_OF_DAY");
    // pausedAt ist der Beginn des offenen Pausen-Intervalls – ohne ihn rechnet
    // closePause beim Fortsetzen nichts auf pausedMs und die Nacht zählt als Arbeit.
    expect(data.pausedAt).toBeInstanceOf(Date);
  });

  it("zählt das NICHT als Arbeitsschritt-Wechsel (switchCount unberührt)", async () => {
    employeeFindMany.mockResolvedValue([employee("ma-1", true)]);
    assignmentFindMany.mockResolvedValue([running("a-1")]);

    await syncCrewmeisterPresence();

    expect(assignmentUpdateMany.mock.calls[0][0].data).not.toHaveProperty("switchCount");
  });

  it("zieht den abgeleiteten Status je betroffenem Schritt nach", async () => {
    employeeFindMany.mockResolvedValue([employee("ma-1", true)]);
    assignmentFindMany.mockResolvedValue([
      running("a-1", "step-1", "task-1"),
      running("a-2", "step-2", "task-2"),
    ]);

    await syncCrewmeisterPresence();

    expect(afterChange).toHaveBeenCalledTimes(2);
    expect(afterChange).toHaveBeenCalledWith("step-1", "task-1");
    expect(afterChange).toHaveBeenCalledWith("step-2", "task-2");
  });

  it("fasst nichts an, wenn der MA gerade nicht arbeitet", async () => {
    employeeFindMany.mockResolvedValue([employee("ma-1", true)]);
    assignmentFindMany.mockResolvedValue([]);

    await syncCrewmeisterPresence();

    expect(assignmentUpdateMany).not.toHaveBeenCalled();
    expect(afterChange).not.toHaveBeenCalled();
  });
});

describe("syncCrewmeisterPresence – Einstempeln", () => {
  it("erinnert an die eigenen unterbrochenen Schritte", async () => {
    employeeFindMany.mockResolvedValue([employee("ma-1", false)]);
    presentIds.mockResolvedValue(new Set([1])); // jetzt eingestempelt

    await syncCrewmeisterPresence();

    expect(employeeUpdate).toHaveBeenCalledWith({
      where: { id: "ma-1" },
      data: { present: true },
    });
    expect(remind).toHaveBeenCalledWith("ma-1");
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
  });
});

// Denselben Nachlauf nutzt die manuelle Anwesenheit im Dashboard
// (PATCH /employees/:id) – sonst wäre der Schalter ein Schlupfloch: „auf
// abwesend stellen" hätte die laufende Arbeit weiterlaufen lassen.
describe("handlePresenceTransition – manuelle Anwesenheit", () => {
  it("unterbricht die laufende Arbeit beim Stellen auf abwesend", async () => {
    assignmentFindMany.mockResolvedValue([running("a-1")]);

    await handlePresenceTransition("ma-1", false);

    expect(assignmentUpdateMany).toHaveBeenCalledTimes(1);
    expect(assignmentUpdateMany.mock.calls[0][0].data.pausedReason).toBe("END_OF_DAY");
    expect(afterChange).toHaveBeenCalledWith("step-1", "task-1");
  });

  it("erinnert beim Stellen auf anwesend", async () => {
    await handlePresenceTransition("ma-1", true);

    expect(remind).toHaveBeenCalledWith("ma-1");
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
  });
});

describe("syncCrewmeisterPresence – Robustheit", () => {
  it("lässt unveränderte Anwesenheit vollständig in Ruhe", async () => {
    employeeFindMany.mockResolvedValue([employee("ma-1", true)]);
    presentIds.mockResolvedValue(new Set([1])); // war schon anwesend

    await expect(syncCrewmeisterPresence()).resolves.toEqual({ changed: 0 });
    expect(employeeUpdate).not.toHaveBeenCalled();
    expect(assignmentUpdateMany).not.toHaveBeenCalled();
    expect(remind).not.toHaveBeenCalled();
  });

  it("bricht den Sync der übrigen MA nicht ab, wenn ein Nachlauf scheitert", async () => {
    employeeFindMany.mockResolvedValue([
      employee("ma-1", false, 1),
      employee("ma-2", false, 2),
    ]);
    presentIds.mockResolvedValue(new Set([1, 2]));
    remind.mockRejectedValueOnce(new Error("Push kaputt"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(syncCrewmeisterPresence()).resolves.toEqual({ changed: 2 });
    expect(remind).toHaveBeenCalledWith("ma-2");
    errSpy.mockRestore();
  });
});
