import { prisma } from "../db.js";

// WAITING = Team-Schritt, der besetzt ist, aber die Mindestbesetzung (minWorkers)
// noch nicht erreicht hat und deshalb noch NICHT läuft (Timer/„In Bearbeitung"
// erst ab min MA). Sobald min erreicht ist (oder der Schritt bereits gestartet
// war), gilt er als ACTIVE.
export type StepStatus = "LOCKED" | "OPEN" | "WAITING" | "ACTIVE" | "PAUSED" | "DONE";

// Schlankes select (statt tiefer Includes): nur die Felder, die die Status-
// Ableitung braucht. Damit lässt sich der Status mit EINER DB-Abfrage je
// Schritt bzw. je Aufgabe holen – kein Nachladen pro Schritt mehr.
export const stepStatusSelect = {
  minWorkers: true,
  startedAt: true,
  assignments: { select: { state: true } },
  predecessors: {
    select: {
      predecessor: {
        select: {
          minWorkers: true,
          assignments: { select: { state: true } },
        },
      },
    },
  },
} as const;

// Form der für die Ableitung nötigen Daten – bewusst entkoppelt von Prisma,
// damit deriveStepStatus rein (ohne DB-Zugriff) bleibt.
type AssignmentLike = { state: string };
type StepStatusInput = {
  minWorkers: number | null;
  startedAt: Date | null;
  assignments: AssignmentLike[];
  predecessors: {
    predecessor: { minWorkers: number | null; assignments: AssignmentLike[] };
  }[];
};

// Ist ein Schritt fertig? – exakt die bisherige Vorgänger-Logik.
// Team-Schritt (min ≥ 2): DONE, sobald eine Assignment DONE ist.
// Einzel-Schritt: DONE, wenn keine ACTIVE/PAUSED mehr übrig sind und mind. eine DONE.
function isStepDone(minWorkers: number | null, assignments: AssignmentLike[]): boolean {
  if (minWorkers && minWorkers >= 2) {
    return assignments.some((a) => a.state === "DONE");
  }
  const active = assignments.filter((a) => a.state === "ACTIVE" || a.state === "PAUSED");
  return active.length === 0 && assignments.some((a) => a.state === "DONE");
}

// Reine Ableitung des Schritt-Status ohne DB-Zugriff.
export function deriveStepStatus(step: StepStatusInput): StepStatus {
  // Gesperrt solange mindestens ein Vorgänger nicht DONE ist.
  const allPredsDone = step.predecessors.every((p) =>
    isStepDone(p.predecessor.minWorkers, p.predecessor.assignments)
  );
  if (!allPredsDone) return "LOCKED";

  const active = step.assignments.filter((a) => a.state === "ACTIVE");
  const paused = step.assignments.filter((a) => a.state === "PAUSED");
  const done = step.assignments.filter((a) => a.state === "DONE");

  if (active.length > 0) {
    // Team-Schritt: solange er noch nicht gestartet ist und die Mindestbesetzung
    // nicht erreicht, „wartet auf Team" (nicht aktiv). Ein bereits gestarteter,
    // zwischenzeitlich unterbesetzter Schritt läuft weiter (bleibt ACTIVE).
    const isTeam = (step.minWorkers ?? 0) >= 2;
    if (isTeam && step.startedAt === null && active.length < (step.minWorkers ?? 0)) {
      return "WAITING";
    }
    return "ACTIVE";
  }
  if (paused.length > 0) return "PAUSED";
  if (done.length > 0) return "DONE";
  return "OPEN";
}

export async function computeTaskStatus(taskId: string) {
  // Alle Schritte der Aufgabe inkl. der für die Ableitung nötigen Relationen in
  // EINER Abfrage holen und dann rein ableiten (kein computeStepStatus je Schritt).
  const steps = await prisma.step.findMany({
    where: { taskId },
    select: stepStatusSelect,
  });
  if (steps.length === 0) return "OPEN" as const;

  const statuses = steps.map(deriveStepStatus);

  if (statuses.every((s) => s === "DONE")) return "COMPLETED" as const;
  if (statuses.some((s) => s === "ACTIVE" || s === "PAUSED")) return "RUNNING" as const;
  return "OPEN" as const;
}
