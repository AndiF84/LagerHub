import { describe, expect, it } from "vitest";
import { deriveStepStatus } from "./stepStatus.js";

// Hilfs-Builder für die schlanke StepStatusInput-Form (entkoppelt von Prisma).
// Standard: Einzel-Schritt (minWorkers null), noch nicht gestartet (startedAt null).
const step = (
  assignments: { state: string }[],
  predecessors: { minWorkers: number | null; assignments: { state: string }[] }[] = [],
  opts: { minWorkers?: number | null; startedAt?: Date | null } = {}
) => ({
  minWorkers: opts.minWorkers ?? null,
  startedAt: opts.startedAt ?? null,
  assignments,
  predecessors: predecessors.map((p) => ({ predecessor: p })),
});

describe("deriveStepStatus", () => {
  describe("ohne Vorgänger", () => {
    it("OPEN, wenn keine Zuweisungen existieren", () => {
      expect(deriveStepStatus(step([]))).toBe("OPEN");
    });

    it("OPEN, wenn nur abgelehnte/angebotene Zuweisungen existieren", () => {
      // OFFERED/REJECTED zählen nicht als Belegung.
      expect(deriveStepStatus(step([{ state: "OFFERED" }, { state: "REJECTED" }]))).toBe("OPEN");
    });

    it("ACTIVE, sobald mindestens eine Zuweisung ACTIVE ist", () => {
      expect(deriveStepStatus(step([{ state: "DONE" }, { state: "ACTIVE" }]))).toBe("ACTIVE");
    });

    it("PAUSED, wenn pausiert aber nichts aktiv", () => {
      expect(deriveStepStatus(step([{ state: "PAUSED" }, { state: "DONE" }]))).toBe("PAUSED");
    });

    it("ACTIVE hat Vorrang vor PAUSED", () => {
      expect(deriveStepStatus(step([{ state: "PAUSED" }, { state: "ACTIVE" }]))).toBe("ACTIVE");
    });

    it("DONE, wenn nur abgeschlossene Zuweisungen übrig sind", () => {
      expect(deriveStepStatus(step([{ state: "DONE" }]))).toBe("DONE");
    });
  });

  describe("Vorgänger-Logik", () => {
    it("LOCKED, solange ein Einzel-Vorgänger nicht DONE ist", () => {
      const pred = { minWorkers: null, assignments: [{ state: "ACTIVE" }] };
      expect(deriveStepStatus(step([], [pred]))).toBe("LOCKED");
    });

    it("OPEN, wenn der einzige Vorgänger fertig ist", () => {
      const pred = { minWorkers: null, assignments: [{ state: "DONE" }] };
      expect(deriveStepStatus(step([], [pred]))).toBe("OPEN");
    });

    it("LOCKED, wenn nur einer von mehreren Vorgängern fertig ist", () => {
      const done = { minWorkers: null, assignments: [{ state: "DONE" }] };
      const open = { minWorkers: null, assignments: [{ state: "ACTIVE" }] };
      expect(deriveStepStatus(step([], [done, open]))).toBe("LOCKED");
    });
  });

  describe("Team-Schritt: WAITING bis Mindestbesetzung", () => {
    it("WAITING, wenn Team-Schritt (min 2) erst 1 aktiven MA hat und noch nicht gestartet", () => {
      expect(deriveStepStatus(step([{ state: "ACTIVE" }], [], { minWorkers: 2 }))).toBe("WAITING");
    });

    it("ACTIVE, sobald die Mindestbesetzung (min 2) erreicht ist", () => {
      expect(
        deriveStepStatus(step([{ state: "ACTIVE" }, { state: "ACTIVE" }], [], { minWorkers: 2 })),
      ).toBe("ACTIVE");
    });

    it("ACTIVE bleibt ein bereits gestarteter Team-Schritt, auch wenn unterbesetzt", () => {
      // startedAt gesetzt = Timer lief schon → läuft weiter (kein Rückfall auf WAITING).
      expect(
        deriveStepStatus(step([{ state: "ACTIVE" }], [], { minWorkers: 2, startedAt: new Date() })),
      ).toBe("ACTIVE");
    });

    it("Einzel-Schritt (min 1) ist mit 1 aktiven MA sofort ACTIVE (kein WAITING)", () => {
      expect(deriveStepStatus(step([{ state: "ACTIVE" }], [], { minWorkers: 1 }))).toBe("ACTIVE");
    });

    it("WAITING erst ab einer aktiven Zuweisung – leer/angeboten bleibt OPEN", () => {
      expect(deriveStepStatus(step([{ state: "OFFERED" }], [], { minWorkers: 2 }))).toBe("OPEN");
    });
  });

  describe("Einzel- vs. Team-Vorgänger (isStepDone)", () => {
    it("Einzel-Vorgänger ist NICHT fertig, wenn noch eine Zuweisung pausiert ist", () => {
      const pred = { minWorkers: 1, assignments: [{ state: "DONE" }, { state: "PAUSED" }] };
      expect(deriveStepStatus(step([], [pred]))).toBe("LOCKED");
    });

    it("Team-Vorgänger (min ≥ 2) ist fertig, sobald EINE Zuweisung DONE ist", () => {
      // Bei Team genügt ein DONE – auch wenn andere noch PAUSED sind.
      const pred = { minWorkers: 2, assignments: [{ state: "DONE" }, { state: "PAUSED" }] };
      expect(deriveStepStatus(step([], [pred]))).toBe("OPEN");
    });

    it("Vorgänger ohne jegliche DONE-Zuweisung ist nicht fertig", () => {
      const pred = { minWorkers: 1, assignments: [{ state: "OFFERED" }] };
      expect(deriveStepStatus(step([], [pred]))).toBe("LOCKED");
    });
  });
});
