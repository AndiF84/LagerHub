import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { deriveStepStatus, stepStatusSelect } from "../services/stepStatus.js";
import {
  notifyReleasedStep,
  notifyAssignmentOffer,
  sendPushToEmployees,
} from "../services/push.js";
import {
  asNoteArray,
  makeCompletionNote,
  validateCompletionNote,
  noteAuthorFromUser,
} from "../services/notes.js";
import { markAvailableSteps, markStepAvailable } from "../services/stepAvailability.js";
import { authAny, authDashboard } from "../auth.js";

const AssignSchema = z.object({
  employeeId: z.string().uuid(),
  stepId: z.string().uuid(),
});

// Abschluss-Body. `note` ist nur bei Schritten mit Step.noteRequired gefragt;
// die inhaltliche Prüfung (leer / Zahl) macht validateCompletionNote gegen die
// am Schritt hinterlegte Form.
const CompleteSchema = z.object({
  note: z.string().max(2000).optional(),
});

// Schließt ein offenes Pausen-Intervall: rechnet die seit `pausedAt` vergangene
// Zeit auf `pausedMs` drauf und gibt die zu schreibenden Felder zurück. Immer
// beim Verlassen des Pausen-Zustands anwenden (Resume/Complete), damit die
// kumulierte Pausenzeit für die Netto-Arbeitszeit-Auswertung stimmt. War die
// Zuweisung nicht pausiert (`pausedAt == null`), bleibt `pausedMs` unverändert.
function closePause(
  a: { pausedAt: Date | null; pausedMs: number },
  now: Date,
): { pausedAt: null; pausedMs: number } {
  const open = a.pausedAt ? now.getTime() - a.pausedAt.getTime() : 0;
  return { pausedAt: null, pausedMs: a.pausedMs + open };
}

// Unterbricht eine ggf. auf einem ANDEREN Schritt aktive Zuweisung desselben MA
// (Wechsel = SWITCH). Ein MA darf nie gleichzeitig auf zwei Schritten ACTIVE sein.
// Wird der verlassene Team-Schritt (min ≥ 2) durch andere weiterhin voll besetzt
// gehalten, wird die pausierte Zuweisung aufgelöst (der Platz wurde ersetzt).
// Gemeinsame Logik von Einloggen/Annehmen (`activateOnStep`) und Fortsetzen (`resume`).
async function pauseActiveOnOtherStep(
  tx: Prisma.TransactionClient,
  employeeId: string,
  keepStepId: string,
) {
  const currentActive = await tx.assignment.findFirst({
    where: { employeeId, state: "ACTIVE", stepId: { not: keepStepId } },
  });
  if (!currentActive) return;

  await tx.assignment.update({
    where: { id: currentActive.id },
    // switchCount +1: das ist ein echter Arbeitsschritt-Wechsel (SWITCH).
    data: { state: "PAUSED", pausedReason: "SWITCH", pausedAt: new Date(), switchCount: { increment: 1 } },
  });

  // Ersatz ist endgültig: hat jemand den Platz aufgefüllt → pausierte Zuweisung auflösen
  const pausedStep = await tx.step.findUniqueOrThrow({
    where: { id: currentActive.stepId },
    select: { minWorkers: true },
  });
  if (pausedStep.minWorkers && pausedStep.minWorkers >= 2) {
    const filledCount = await tx.assignment.count({
      where: { stepId: currentActive.stepId, state: "ACTIVE" },
    });
    if (filledCount >= (pausedStep.minWorkers ?? 0)) {
      await tx.assignment.delete({ where: { id: currentActive.id } });
    }
  }
}

// Kern-Logik zum Aktivieren eines MA auf einem Schritt – wird sowohl beim
// Selbst-Login (POST /) als auch beim Annehmen eines Angebots (POST /:id/accept)
// genutzt. Läuft innerhalb einer Transaktion mit Zeilensperre auf den Schritt,
// damit die Kapazitätsprüfung atomisch ist. `promoteAssignmentId` hebt ein
// bestehendes OFFERED-Assignment auf ACTIVE, sonst wird neu angelegt.
async function activateOnStep(
  tx: Prisma.TransactionClient,
  { employeeId, stepId, promoteAssignmentId }: {
    employeeId: string;
    stepId: string;
    promoteAssignmentId?: string;
  },
) {
  // Zeilensperre auf den Schritt: serialisiert gleichzeitige Logins/Annahmen.
  await tx.$queryRaw`SELECT id FROM "Step" WHERE id = ${stepId} FOR UPDATE`;

  const step = await tx.step.findUniqueOrThrow({
    where: { id: stepId },
    select: {
      skillId: true,
      minWorkers: true,
      maxWorkers: true,
      startedAt: true,
      taskId: true,
      assignments: {
        // OFFERED gehört dazu, weil auch ein offenes Angebot eine Zuweisung des
        // MA auf diesem Schritt ist (siehe Doppel-Prüfung unten). Für die
        // Kapazität zählt weiterhin nur ACTIVE – der Filter dort bleibt.
        where: { state: { in: ["ACTIVE", "PAUSED", "OFFERED"] } },
        select: { id: true, state: true, employeeId: true },
      },
    },
  });

  // Anwesenheit UND Fähigkeit in EINER Abfrage: Mitarbeiter mit auf den
  // benötigten Skill gefiltertem skills-Include holen (statt zwei separater
  // Roundtrips employee + employeeSkill). present/deletedAt prüfen die
  // Einsetzbarkeit, ein leeres skills-Array bedeutet „Fähigkeit fehlt".
  const employee = await tx.employee.findUnique({
    where: { id: employeeId },
    select: {
      present: true,
      deletedAt: true,
      skills: { where: { skillId: step.skillId }, select: { skillId: true } },
    },
  });
  if (!employee || employee.deletedAt) {
    throw Object.assign(new Error("Mitarbeiter nicht gefunden"), { statusCode: 404 });
  }
  if (!employee.present) {
    throw Object.assign(new Error("Mitarbeiter ist nicht anwesend"), { statusCode: 409 });
  }
  if (employee.skills.length === 0) {
    throw Object.assign(new Error("Mitarbeiter hat nicht die erforderliche Fähigkeit"), {
      statusCode: 403,
    });
  }

  // Derselbe MA darf auf DEMSELBEN Schritt nur eine Zuweisung haben. Ohne diese
  // Prüfung legte jeder weitere Login eine zweite an: der MA belegte mehrere
  // Plätze, und beim Abschluss schrieb `finalizeTask` ZWEI WorkLog-Zeilen für
  // eine Person auf einem Schritt – die Auswertung zählte den Schritt doppelt
  // und addierte die Zeiten. Der häufigste Weg dorthin war harmlos: unterbrechen
  // und danach „Einloggen" statt „Fortsetzen" drücken (PAUSED + ACTIVE).
  // `POST /offer` kannte diese Regel schon; hier fehlte sie. Steht VOR der
  // Kapazitäts-Prüfung, damit „schon eingesetzt" die genauere Meldung gewinnt,
  // und ist dank der FOR-UPDATE-Sperre oben atomar.
  // DONE/REJECTED sind bewusst ausgenommen: nach Abschluss oder Ablehnung darf
  // sich derselbe MA erneut auf den Schritt setzen.
  const own = step.assignments.find(
    (a) => a.employeeId === employeeId && a.id !== promoteAssignmentId,
  );
  if (own) {
    throw Object.assign(
      new Error("Mitarbeiter ist hier bereits eingesetzt oder hat ein offenes Angebot"),
      { statusCode: 409 },
    );
  }

  // Kapazitäts-Prüfung (atomisch dank FOR-UPDATE-Sperre oben)
  const activeCount = step.assignments.filter((a) => a.state === "ACTIVE").length;
  if (step.maxWorkers !== null && activeCount >= step.maxWorkers) {
    throw Object.assign(new Error(`Schritt gerade voll (${activeCount}/${step.maxWorkers})`), {
      statusCode: 409,
    });
  }

  // Bereits aktive Zuweisung des MA auf einem anderen Schritt pausieren
  await pauseActiveOnOtherStep(tx, employeeId, stepId);

  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const assignment = promoteAssignmentId
    ? await tx.assignment.update({
        where: { id: promoteAssignmentId },
        data: { state: "ACTIVE", pausedReason: null, pausedAt: null, dayKey: today, startedAt: now },
        include: { step: true, employee: true },
      })
    : await tx.assignment.create({
        data: { stepId, employeeId, dayKey: today, state: "ACTIVE" },
        include: { step: true, employee: true },
      });

  // Timer-Start: Einzel-Schritt sofort; Team-Schritt (min ≥ 2) erst bei min.
  const isTeam = (step.minWorkers ?? 0) >= 2;
  const newActiveCount = activeCount + 1;
  const timerStarted =
    step.startedAt === null && (!isTeam || newActiveCount >= (step.minWorkers ?? 0));
  if (timerStarted) {
    await tx.step.update({ where: { id: stepId }, data: { startedAt: now } });
  }

  // Aufgabe „startet" (status RUNNING + startedAt) erst, wenn auch der Schritt-
  // Timer wirklich anläuft. Ein Team-Schritt mit erst 1/2 MA (WAITING) lässt die
  // Aufgabe also unter „Offen – noch nicht begonnen", bis die Mindestbesetzung da
  // ist. (Der Status wird in afterAssignmentChange ohnehin neu abgeleitet; hier
  // zählt vor allem das Setzen von startedAt, das die Dashboard-Einordnung steuert.)
  if (timerStarted) {
    await tx.task.updateMany({
      where: { id: step.taskId, status: "OPEN" },
      data: { status: "RUNNING", startedAt: now },
    });
  }

  return { assignment, taskId: step.taskId, timerStarted };
}

// Exportiert, weil der Anwesenheits-Sync (services/presence.ts) beim Ausstempeln
// Zuweisungen unterbricht und danach denselben Nachlauf braucht (Status ableiten,
// ASSIGNMENT_CHANGED, Team-Unterbesetzung). Die Logik hängt an `finalizeTask`/
// `handleStepUnlocks` in dieser Datei – ein Verschieben nach services/ wäre der
// sauberere Schnitt, zieht aber den ganzen Abschluss-Pfad mit.
export async function afterAssignmentChange(stepId: string, taskId: string) {
  // Alle Schritte der Aufgabe EINMAL mit den Status-Relationen holen und daraus
  // sowohl den Aufgaben-Status als auch den Status DIESES Schritts ableiten –
  // spart die früheren Einzelabfragen computeStepStatus + computeTaskStatus sowie
  // das erneute Nachladen für den Understaffed-Check.
  const steps = await prisma.step.findMany({
    where: { taskId },
    select: { id: true, name: true, ...stepStatusSelect },
  });

  const statusByStep = new Map(steps.map((s) => [s.id, deriveStepStatus(s)] as const));
  const stepStatus = statusByStep.get(stepId) ?? "OPEN";

  const statuses = [...statusByStep.values()];
  let taskStatus: "OPEN" | "RUNNING" | "COMPLETED";
  if (statuses.length > 0 && statuses.every((s) => s === "DONE")) {
    taskStatus = "COMPLETED";
  } else if (statuses.some((s) => s === "ACTIVE" || s === "PAUSED")) {
    taskStatus = "RUNNING";
  } else {
    taskStatus = "OPEN";
  }

  await prisma.task.update({ where: { id: taskId }, data: { status: taskStatus } });

  publish("lagerhub", {
    type: "ASSIGNMENT_CHANGED",
    stepId,
    taskId,
    stepStatus,
    taskStatus,
  });

  // Team-Schritt unter min gefallen (läuft bereits, ist nicht erledigt) → Warnung.
  // Der Schritt läuft trotzdem weiter; das ist nur ein Hinweis an den Manager.
  if (stepStatus !== "DONE") {
    const step = steps.find((s) => s.id === stepId);
    const min = step?.minWorkers ?? 0;
    const activeCount = step
      ? step.assignments.filter((a) => a.state === "ACTIVE").length
      : 0;
    if (step && min >= 2 && step.startedAt && activeCount < min) {
      publish("lagerhub", {
        type: "TEAM_UNDERSTAFFED",
        stepId,
        taskId,
        stepName: step.name,
        active: activeCount,
        min,
      });
    }
  }

  // Schritt gerade fertiggestellt → ggf. Nachfolger freigeschaltet
  // (STEP_UNLOCKED + Regel-2-Push bei hoher Priorität)
  if (stepStatus === "DONE") {
    await handleStepUnlocks(stepId, taskId);
  }

  // Aufgabe abgeschlossen → Historien-Eintrag schreiben, zurücksetzen
  if (taskStatus === "COMPLETED") {
    await finalizeTask(taskId);
  }
}

// Prüft die Nachfolger eines gerade erledigten Schritts: Wird einer dadurch
// freigeschaltet (alle Vorgänger erledigt, noch keine Zuweisung), wird
// STEP_UNLOCKED publiziert und – bei hoher Priorität – Push ausgelöst (Regel 2).
async function handleStepUnlocks(completedStepId: string, taskId: string) {
  const successors = await prisma.stepPredecessor.findMany({
    where: { predecessorId: completedStepId },
    select: { stepId: true },
  });
  if (successors.length === 0) return;

  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: { priority: true },
  });

  // Status aller Nachfolger in EINER Abfrage holen und rein ableiten (kein N+1).
  const statusRows = await prisma.step.findMany({
    where: { id: { in: successors.map((s) => s.stepId) } },
    select: { id: true, ...stepStatusSelect },
  });
  const statusById = new Map(statusRows.map((r) => [r.id, deriveStepStatus(r)] as const));

  for (const { stepId: succId } of successors) {
    const status = statusById.get(succId)!;
    if (status === "OPEN") {
      // Genau hier wird der Schritt abholbar → Startpunkt für „wartet seit X"
      // und für die Eskalations-Schwelle festhalten (vorher gab es dafür keine
      // Spur; der Scheduler behalf sich mit dem Aufgaben-Start).
      await markStepAvailable(succId);
      publish("lagerhub", { type: "STEP_UNLOCKED", stepId: succId, taskId });
      if (task?.priority === "HIGH") {
        await notifyReleasedStep(succId);
      }
    }
  }
}

async function finalizeTask(taskId: string) {
  const task = await prisma.task.findUniqueOrThrow({
    where: { id: taskId },
    include: {
      steps: {
        include: { assignments: true },
      },
    },
  });

  const now = new Date();

  // Snapshot-Schritte (mit geschlossenen Pausen) einmal vorbereiten – dient
  // sowohl dem TaskRun.data-JSON als auch den abgeleiteten WorkLog-Zeilen.
  const snapshotSteps = task.steps.map((s) => ({
    id: s.id,
    name: s.name,
    // Timer-Start (Team: erst ab Mindestbesetzung) – für die Schrittdauer im
    // Tagesjournal, damit reine Wartezeit vor dem Start nicht mitzählt.
    startedAt: s.startedAt,
    // Defensive: ein evtl. noch offenes Pausen-Intervall in pausedMs einrechnen,
    // damit Snapshot UND WorkLog eine saubere Netto-Arbeitszeit erlauben
    // (finishedAt − startedAt − pausedMs).
    assignments: s.assignments.map((a) => (a.pausedAt ? { ...a, ...closePause(a, now) } : a)),
    // Notiz-Verlauf einfrieren (Admins können in der Historie nachtragen).
    notes: asNoteArray(s.notes),
  }));

  await prisma.$transaction(async (tx) => {
    const run = await tx.taskRun.create({
      data: {
        taskId,
        taskName: task.name,
        startedAt: task.startedAt ?? now,
        finishedAt: now,
        data: { steps: snapshotSteps } as unknown as Prisma.InputJsonValue,
      },
    });

    // WorkLog: eine denormalisierte Auswertungs-Zeile je Zuweisung je Schritt.
    const logs = snapshotSteps.flatMap((s) =>
      s.assignments.map((a) => {
        const finishedAt = a.finishedAt ?? now;
        return {
          runId: run.id,
          employeeId: a.employeeId,
          taskName: task.name,
          stepName: s.name,
          startedAt: a.startedAt,
          finishedAt,
          activeMs: Math.max(0, finishedAt.getTime() - a.startedAt.getTime() - a.pausedMs),
          pausedMs: a.pausedMs,
          switchCount: a.switchCount,
        };
      }),
    );
    if (logs.length) await tx.workLog.createMany({ data: logs });

    // Lauf-Assignments entfernen: der Schritt-/Aufgabenstatus wird abgeleitet,
    // also muss der abgeschlossene Lauf weggeräumt werden, sonst bleibt die
    // Aufgabe dauerhaft "COMPLETED" und ist nicht wiederverwendbar.
    await tx.assignment.deleteMany({ where: { step: { taskId } } });
    // Timer, Notizen UND Verfügbarkeits-Zeitpunkt der Schritte zurücksetzen für
    // den nächsten Lauf (der Verlauf ist nun im TaskRun-Snapshot eingefroren).
    // `availableAt` muss mit: sonst startete der nächste Lauf mit den Zeitpunkten
    // des alten und zeigte sofort ein Alter von Stunden/Tagen.
    await tx.step.updateMany({
      where: { taskId },
      data: { startedAt: null, notes: [], availableAt: null },
    });
    // Status/Timer für den nächsten Lauf zurücksetzen. Standard: aus dem Pool
    // nehmen (poolEnabled false) – ein neuer Lauf kommt nur über die Aufgaben-
    // Maske ("Starten"). Ausnahme "Wiederholen" (task.repeat): im Pool halten,
    // dann startet dieselbe Aufgabe (dank startedAt=null) sofort wieder als
    // offener Lauf – kein manueller Neustart nötig.
    await tx.task.update({
      where: { id: taskId },
      data: { status: "OPEN", startedAt: null, finishedAt: now, poolEnabled: task.repeat },
    });
  });

  publish("lagerhub", { type: "TASK_COMPLETED", taskId });
  // Bei Wiederholung steht die Aufgabe sofort wieder im Pool → Dashboard/Pool
  // aktualisieren (TASK_RESTARTED invalidiert die Pool-Ansicht). Der neue Lauf
  // ist ab jetzt abholbar, also die Uhr für die Eingangs-Schritte neu starten
  // (oben wurde sie gerade auf null gesetzt).
  if (task.repeat) {
    await markAvailableSteps(taskId);
    publish("lagerhub", { type: "TASK_RESTARTED", taskId });
  }
}

// Erinnerung an einen MA mit eigenen unterbrochenen (PAUSED) Schritten – er hat
// dort etwas angefangen, das noch nicht beendet ist. Zwei Auslöser, beide an ein
// Ereignis gebunden statt an eine Uhrzeit:
//   1. Er schließt einen (weiteren) Schritt ab – siehe POST /:id/complete.
//   2. Er stempelt sich morgens wieder ein – siehe services/presence.ts
//      (deshalb exportiert). So erfährt er beim Arbeitsbeginn, wo er gestern
//      stehengeblieben ist.
export async function remindOwnInterruptedSteps(employeeId: string) {
  const interrupted = await prisma.assignment.findMany({
    where: { employeeId, state: "PAUSED" },
    include: { step: { include: { task: true } }, employee: { select: { name: true } } },
  });
  if (interrupted.length === 0) return;

  for (const a of interrupted) {
    publish("lagerhub", {
      type: "WORK_REMINDER",
      employeeId,
      employeeName: a.employee.name,
      stepId: a.stepId,
      stepName: a.step.name,
      taskName: a.step.task.name,
    });
  }

  // Best-effort-Push (PWA): kompakte Sammel-Erinnerung an die unterbrochenen Schritte.
  const labels = interrupted.map((a) => `„${a.step.name}" (${a.step.task.name})`).join(", ");
  await sendPushToEmployees([employeeId], {
    title: "Noch unterbrochene Schritte",
    body:
      interrupted.length === 1
        ? `Du hast ${labels} noch nicht beendet.`
        : `Du hast noch ${interrupted.length} unterbrochene Schritte: ${labels}`,
  });
}

// Ein WORKER (PWA) darf nur seine EIGENEN Zuweisungen bedienen (annehmen,
// ablehnen, abschließen, unterbrechen, fortsetzen, verlassen). Ohne diese Prüfung
// könnte ein MA per direktem API-Aufruf fremde Zuweisungen manipulieren – die
// preHandler-Guards prüfen nur „gültiges Token", nicht die Zugehörigkeit.
// Dashboard-Rollen (OFFICE/MANAGER/ADMIN) dürfen für jeden MA handeln (Eingriff).
async function assertMayActOnAssignment(req: FastifyRequest, assignmentId: string): Promise<void> {
  if (req.user.role !== "WORKER") return;
  const a = await prisma.assignment.findUnique({
    where: { id: assignmentId },
    select: { employeeId: true },
  });
  // Nicht gefunden → als 404 behandeln (der Handler meldet dasselbe konsistent).
  if (!a) throw Object.assign(new Error("Zuweisung nicht gefunden"), { statusCode: 404 });
  if (a.employeeId !== req.user.sub) {
    throw Object.assign(new Error("Diese Zuweisung gehört einem anderen Mitarbeiter"), {
      statusCode: 403,
    });
  }
}

export const assignmentRoutes: FastifyPluginAsync = async (app) => {
  // Basis: jede Zuweisungs-Aktion braucht ein gültiges Token. /offer (Manager
  // setzt einen MA ein) wird zusätzlich auf Dashboard-Rollen eingeschränkt.
  app.addHook("preHandler", authAny);

  // Einloggen in einen Schritt (Selbst-Login durch den MA). Identität kommt aus
  // dem Token (req.user.sub), NICHT aus dem Body – ein MA kann sich nur selbst
  // einloggen, nie im Namen eines anderen. (Manager setzen andere via /offer ein.)
  app.post("/", async (req, reply) => {
    const { stepId } = z.object({ stepId: z.string().uuid() }).parse(req.body);
    const employeeId = req.user.sub;

    const result = await prisma.$transaction((tx) => activateOnStep(tx, { employeeId, stepId }));

    if (result.timerStarted) {
      publish("lagerhub", { type: "STEP_TIMER_STARTED", stepId, taskId: result.taskId });
    }
    await afterAssignmentChange(stepId, result.taskId);
    return reply.status(201).send(result.assignment);
  });

  // Manager bietet einem MA einen Schritt an (unverbindlich – belegt KEINEN
  // Platz, bis der MA annimmt). Best-effort-Push an den MA.
  app.post("/offer", { preHandler: [authDashboard] }, async (req, reply) => {
    const { employeeId, stepId } = AssignSchema.parse(req.body);

    const step = await prisma.step.findUnique({
      where: { id: stepId },
      include: { skill: true, task: { select: { id: true } } },
    });
    if (!step) return reply.status(404).send({ error: "Schritt nicht gefunden" });

    const employee = await prisma.employee.findUnique({
      where: { id: employeeId },
      select: { present: true, deletedAt: true },
    });
    if (!employee || employee.deletedAt) {
      return reply.status(404).send({ error: "Mitarbeiter nicht gefunden" });
    }
    if (!employee.present) {
      return reply.status(409).send({ error: "Mitarbeiter ist nicht anwesend" });
    }

    const hasSkill = await prisma.employeeSkill.findFirst({
      where: { employeeId, skillId: step.skillId },
    });
    if (!hasSkill) {
      return reply
        .status(403)
        .send({ error: "Mitarbeiter hat nicht die erforderliche Fähigkeit" });
    }

    // Kein doppeltes Angebot / nicht anbieten, wenn schon eingesetzt
    const existing = await prisma.assignment.findFirst({
      where: { employeeId, stepId, state: { in: ["OFFERED", "ACTIVE", "PAUSED"] } },
    });
    if (existing) {
      return reply.status(409).send({
        error: "Mitarbeiter ist hier bereits eingesetzt oder hat ein offenes Angebot",
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const assignment = await prisma.assignment.create({
      data: { stepId, employeeId, dayKey: today, state: "OFFERED" },
      include: { step: true, employee: true },
    });

    publish("lagerhub", {
      type: "ASSIGNMENT_OFFERED",
      stepId,
      taskId: step.task.id,
      employeeId,
      assignmentId: assignment.id,
    });
    await notifyAssignmentOffer(assignment.id);

    return reply.status(201).send(assignment);
  });

  // MA nimmt ein Angebot an → wird ACTIVE (gleiche Logik wie Selbst-Login).
  app.post("/:id/accept", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertMayActOnAssignment(req, id);

    const result = await prisma.$transaction(async (tx) => {
      const offered = await tx.assignment.findUnique({ where: { id } });
      if (!offered) {
        throw Object.assign(new Error("Angebot nicht gefunden"), { statusCode: 404 });
      }
      if (offered.state !== "OFFERED") {
        throw Object.assign(new Error("Angebot ist nicht (mehr) offen"), { statusCode: 409 });
      }
      return activateOnStep(tx, {
        employeeId: offered.employeeId,
        stepId: offered.stepId,
        promoteAssignmentId: id,
      });
    });

    if (result.timerStarted) {
      publish("lagerhub", {
        type: "STEP_TIMER_STARTED",
        stepId: result.assignment.stepId,
        taskId: result.taskId,
      });
    }
    await afterAssignmentChange(result.assignment.stepId, result.taskId);
    return reply.status(200).send(result.assignment);
  });

  // MA lehnt ein Angebot ab → REJECTED + Meldung fürs Dashboard.
  app.post("/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertMayActOnAssignment(req, id);

    const a = await prisma.assignment.findUnique({
      where: { id },
      include: { employee: true, step: { include: { task: true } } },
    });
    if (!a) return reply.status(404).send({ error: "Angebot nicht gefunden" });
    if (a.state !== "OFFERED") {
      return reply.status(409).send({ error: "Angebot ist nicht (mehr) offen" });
    }

    await prisma.assignment.update({ where: { id }, data: { state: "REJECTED" } });

    publish("lagerhub", {
      type: "ASSIGNMENT_REJECTED",
      assignmentId: id,
      stepId: a.stepId,
      taskId: a.step.taskId,
      employeeId: a.employeeId,
      employeeName: a.employee.name,
      stepName: a.step.name,
      taskName: a.step.task.name,
    });

    return { ok: true };
  });

  // Zuweisung abschließen
  app.post("/:id/complete", async (req) => {
    const { id } = req.params as { id: string };
    await assertMayActOnAssignment(req, id);
    const { note } = CompleteSchema.parse(req.body ?? {});

    const assignment = await prisma.assignment.findUniqueOrThrow({
      where: { id },
      include: { step: true },
    });

    const isTeamStep = (assignment.step.minWorkers ?? 0) >= 2;

    // Pflichtnotiz: ohne gültigen Wert kein Abschluss. Muss hier im Backend
    // stehen und nicht nur in der Oberfläche – Dashboard-Rollen dürfen laut
    // assertMayActOnAssignment auch fremde Zuweisungen abschließen, das wäre
    // sonst ein zweiter Weg an der Regel vorbei. Bei einem Team-Schritt reicht
    // EINE Angabe (der Abschließende gibt sie für alle ab): die Menge ist eine
    // Eigenschaft des Schritts, nicht der einzelnen Person.
    let completionNote: ReturnType<typeof makeCompletionNote> | null = null;
    if (assignment.step.noteRequired) {
      const check = validateCompletionNote(
        note,
        assignment.step.noteFormat,
        assignment.step.noteLabel,
      );
      if (!check.ok) throw Object.assign(new Error(check.error), { statusCode: 400 });

      const { authorType, authorName } = noteAuthorFromUser(req.user);
      completionNote = makeCompletionNote(
        check.text,
        authorType,
        authorName,
        assignment.step.noteLabel,
        check.value,
      );
    }

    // Team-Schritt darf erst abgeschlossen werden, wenn die Mindestbesetzung
    // erreicht war (Timer gestartet, `startedAt` gesetzt). Vorher (Status WAITING)
    // ist „abschließen" unzulässig – sonst könnte ein einzelner MA einen Team-
    // Schritt allein beenden (z. B. nachdem er sich vom wartenden Schritt weg-
    // unterbrochen hat und im PAUSED-Zustand „Abschließen" drückt).
    if (isTeamStep && assignment.step.startedAt === null) {
      throw Object.assign(
        new Error("Team-Schritt ist noch nicht vollständig besetzt – kann noch nicht abgeschlossen werden."),
        { statusCode: 409 },
      );
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      // Pflichtnotiz im SELBEN Transaktions-Schritt anhängen wie den Abschluss –
      // sonst könnte der Schritt fertig werden und die Angabe verloren gehen.
      if (completionNote) {
        const current = await tx.step.findUniqueOrThrow({
          where: { id: assignment.stepId },
          select: { notes: true },
        });
        const notes = asNoteArray(current.notes);
        notes.push(completionNote);
        await tx.step.update({
          where: { id: assignment.stepId },
          data: { notes: notes as unknown as Prisma.InputJsonValue },
        });
      }

      if (isTeamStep) {
        // Team-Schritt: einer schließt für alle ab. Pro Zeile, damit ein noch
        // offenes Pausen-Intervall je Mitglied korrekt in pausedMs einfließt.
        const members = await tx.assignment.findMany({
          where: { stepId: assignment.stepId, state: { in: ["ACTIVE", "PAUSED"] } },
          select: { id: true, pausedAt: true, pausedMs: true },
        });
        for (const m of members) {
          await tx.assignment.update({
            where: { id: m.id },
            data: { state: "DONE", finishedAt: now, ...closePause(m, now) },
          });
        }
      } else {
        // Einzel-Schritt: der Abschließende beendet seine eigene Zuweisung.
        await tx.assignment.update({
          where: { id },
          data: { state: "DONE", finishedAt: now, ...closePause(assignment, now) },
        });

        // Einzel-Slot-Schritt (max 1): Hat MA1 pausiert und MA2 den Schritt
        // übernommen + abgeschlossen, ist die Arbeit erledigt. MA1s noch PAUSED
        // hängende Zuweisung würde den Schritt sonst dauerhaft auf „pausiert"
        // halten (isStepDone verlangt: keine ACTIVE/PAUSED mehr übrig). Daher die
        // übernommenen Pausen mit abschließen → Schritt wird DONE. closePause
        // rechnet die Pausendauer korrekt heraus, sodass MA1 nur seine echte
        // Arbeitszeit (Start bis Pause) gutgeschrieben bekommt.
        if (assignment.step.maxWorkers === 1) {
          const paused = await tx.assignment.findMany({
            where: { stepId: assignment.stepId, state: "PAUSED" },
            select: { id: true, pausedAt: true, pausedMs: true },
          });
          for (const p of paused) {
            await tx.assignment.update({
              where: { id: p.id },
              data: { state: "DONE", finishedAt: now, ...closePause(p, now) },
            });
          }
        }
      }
    });

    await afterAssignmentChange(assignment.stepId, assignment.step.taskId);
    // Hat der MA selbst noch unterbrochene Schritte offen → daran erinnern.
    await remindOwnInterruptedSteps(assignment.employeeId);
    return { ok: true };
  });

  // Zuweisung manuell pausieren (z. B. für Feierabend durch Scheduler)
  app.post("/:id/pause", async (req) => {
    const { id } = req.params as { id: string };
    await assertMayActOnAssignment(req, id);
    const { reason } = z
      .object({ reason: z.enum(["SWITCH", "END_OF_DAY"]).default("SWITCH") })
      .parse(req.body);

    const assignment = await prisma.assignment.update({
      where: { id },
      // switchCount nur bei echtem Wechsel (SWITCH = manuelles „Unterbrechen"),
      // NICHT bei Feierabend (END_OF_DAY).
      data: {
        state: "PAUSED",
        pausedReason: reason,
        pausedAt: new Date(),
        ...(reason === "SWITCH" ? { switchCount: { increment: 1 } } : {}),
      },
      include: { step: true },
    });

    await afterAssignmentChange(assignment.stepId, assignment.step.taskId);
    return assignment;
  });

  // Zuweisung fortsetzen
  app.post("/:id/resume", async (req) => {
    const { id } = req.params as { id: string };
    await assertMayActOnAssignment(req, id);

    const assignment = await prisma.$transaction(async (tx) => {
      const existing = await tx.assignment.findUniqueOrThrow({
        where: { id },
        include: { step: true },
      });

      // Anwesenheit prüfen – gleiche Regel wie beim Einloggen/Annehmen
      // (`activateOnStep`). Ohne das wäre die automatische Unterbrechung beim
      // Ausstempeln zahnlos: der MA drückt „Fortsetzen" und die Uhr liefe weiter,
      // obwohl er nicht mehr eingestempelt ist. Geprüft wird der MA der Zuweisung,
      // nicht der Handelnde – ein Manager kann für ihn also ebenso wenig fortsetzen.
      const employee = await tx.employee.findUnique({
        where: { id: existing.employeeId },
        select: { present: true, deletedAt: true },
      });
      if (!employee || employee.deletedAt) {
        throw Object.assign(new Error("Mitarbeiter nicht gefunden"), { statusCode: 404 });
      }
      if (!employee.present) {
        throw Object.assign(new Error("Mitarbeiter ist nicht anwesend"), { statusCode: 409 });
      }

      // Zeilensperre auf den Schritt → atomische Kapazitätsprüfung (wie beim Login)
      await tx.$queryRaw`SELECT id FROM "Step" WHERE id = ${existing.stepId} FOR UPDATE`;

      const activeCount = await tx.assignment.count({
        where: { stepId: existing.stepId, state: "ACTIVE" },
      });
      if (existing.step.maxWorkers !== null && activeCount >= existing.step.maxWorkers) {
        throw Object.assign(
          new Error(`Schritt gerade voll (${activeCount}/${existing.step.maxWorkers})`),
          { statusCode: 409 }
        );
      }

      // Ein MA darf nie auf zwei Schritten gleichzeitig aktiv sein: einen ggf.
      // laufenden anderen Schritt beim Fortsetzen automatisch unterbrechen (SWITCH).
      await pauseActiveOnOtherStep(tx, existing.employeeId, existing.stepId);

      return tx.assignment.update({
        where: { id },
        // closePause addiert das offene Intervall auf pausedMs und setzt pausedAt null.
        data: { state: "ACTIVE", pausedReason: null, ...closePause(existing, new Date()) },
        include: { step: true },
      });
    });

    await afterAssignmentChange(assignment.stepId, assignment.step.taskId);
    return assignment;
  });

  // MA verlässt einen noch NICHT gestarteten Schritt wieder (gibt den Platz frei,
  // OHNE Arbeitszeit zu buchen). Gedacht für Team-Schritte, die die Mindest-
  // besetzung noch nicht erreicht haben (Status WAITING, Timer nicht gestartet) und
  // sich vor Beginn noch umbesetzen. Anders als „Unterbrechen" bleibt keine PAUSED-
  // Zuweisung zurück – die Zuweisung wird gelöscht. Nach Timer-Start nicht mehr
  // möglich (dann unterbrechen/abschließen), damit keine bereits geleistete Arbeit
  // spurlos verschwindet.
  app.post("/:id/leave", async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertMayActOnAssignment(req, id);

    const result = await prisma.$transaction(async (tx) => {
      const a = await tx.assignment.findUnique({
        where: { id },
        select: { state: true, stepId: true, step: { select: { taskId: true } } },
      });
      if (!a) throw Object.assign(new Error("Zuweisung nicht gefunden"), { statusCode: 404 });
      if (a.state !== "ACTIVE" && a.state !== "PAUSED") {
        throw Object.assign(new Error("Zuweisung ist nicht aktiv"), { statusCode: 409 });
      }

      // Zeilensperre → serialisiert mit gleichzeitigen Logins/Timer-Start; danach
      // den Timer-Stand FRISCH lesen (könnte zwischen Fund und Sperre gestartet sein).
      await tx.$queryRaw`SELECT id FROM "Step" WHERE id = ${a.stepId} FOR UPDATE`;
      const step = await tx.step.findUniqueOrThrow({
        where: { id: a.stepId },
        select: { startedAt: true },
      });
      if (step.startedAt !== null) {
        throw Object.assign(
          new Error("Schritt läuft bereits – bitte unterbrechen oder abschließen"),
          { statusCode: 409 },
        );
      }

      // deleteMany (statt delete) schützt vor P2025, falls die Zuweisung zwischen
      // Fund und Sperre bereits verschwand; count 0 → schon weg.
      const deleted = await tx.assignment.deleteMany({
        where: { id, state: { in: ["ACTIVE", "PAUSED"] } },
      });
      if (deleted.count === 0) {
        throw Object.assign(new Error("Zuweisung ist nicht (mehr) aktiv"), { statusCode: 409 });
      }
      return { stepId: a.stepId, taskId: a.step.taskId };
    });

    await afterAssignmentChange(result.stepId, result.taskId);
    return reply.status(200).send({ ok: true });
  });
};
