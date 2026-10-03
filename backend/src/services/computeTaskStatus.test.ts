import { beforeEach, describe, expect, it, vi } from "vitest";

// db.js mocken, bevor stepStatus.js es importiert (vi.mock wird hochgezogen).
// computeTaskStatus liest nur über prisma.step.findMany – das genügt als Mock.
vi.mock("../db.js", () => ({
  prisma: { step: { findMany: vi.fn() } },
}));

import { prisma } from "../db.js";
import { computeTaskStatus } from "./stepStatus.js";

const findMany = prisma.step.findMany as unknown as ReturnType<typeof vi.fn>;

// Baut einen Schritt in der von stepStatusSelect gelieferten Form.
const step = (
  assignments: { state: string }[],
  predecessors: { minWorkers: number | null; assignments: { state: string }[] }[] = []
) => ({
  assignments,
  predecessors: predecessors.map((p) => ({ predecessor: p })),
});

// Lässt den nächsten findMany-Aufruf die übergebenen Schritte liefern.
const givenSteps = (...steps: ReturnType<typeof step>[]) => {
  findMany.mockResolvedValueOnce(steps);
};

beforeEach(() => {
  findMany.mockReset();
});

describe("computeTaskStatus", () => {
  it("OPEN, wenn die Aufgabe keine Schritte hat", async () => {
    givenSteps();
    await expect(computeTaskStatus("task-1")).resolves.toBe("OPEN");
  });

  it("COMPLETED, wenn alle Schritte DONE sind", async () => {
    givenSteps(step([{ state: "DONE" }]), step([{ state: "DONE" }]));
    await expect(computeTaskStatus("task-1")).resolves.toBe("COMPLETED");
  });

  it("RUNNING, sobald ein Schritt ACTIVE ist", async () => {
    givenSteps(step([{ state: "ACTIVE" }]), step([]));
    await expect(computeTaskStatus("task-1")).resolves.toBe("RUNNING");
  });

  it("RUNNING, wenn ein Schritt PAUSED ist (auch ohne ACTIVE)", async () => {
    givenSteps(step([{ state: "DONE" }]), step([{ state: "PAUSED" }]));
    await expect(computeTaskStatus("task-1")).resolves.toBe("RUNNING");
  });

  it("OPEN, wenn alle Schritte offen sind", async () => {
    givenSteps(step([]), step([]));
    await expect(computeTaskStatus("task-1")).resolves.toBe("OPEN");
  });

  it("OPEN bei Mix aus DONE und OPEN (kein ACTIVE/PAUSED, nicht alle DONE)", async () => {
    givenSteps(step([{ state: "DONE" }]), step([]));
    await expect(computeTaskStatus("task-1")).resolves.toBe("OPEN");
  });

  it("nicht COMPLETED, wenn ein Schritt durch offenen Vorgänger LOCKED ist", async () => {
    // LOCKED zählt weder als DONE noch als ACTIVE/PAUSED → Aufgabe bleibt OPEN.
    const lockedByPred = step([], [{ minWorkers: null, assignments: [{ state: "ACTIVE" }] }]);
    givenSteps(step([{ state: "DONE" }]), lockedByPred);
    await expect(computeTaskStatus("task-1")).resolves.toBe("OPEN");
  });

  it("fragt die Schritte genau einer Aufgabe ab", async () => {
    givenSteps(step([]));
    await computeTaskStatus("task-42");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { taskId: "task-42" } });
  });
});
