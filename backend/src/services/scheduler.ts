import cron from "node-cron";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { afterAssignmentChange } from "../routes/assignments.js";
import { sendPushToEmployees } from "./push.js";
import { crewmeisterConfigured } from "./crewmeister.js";
import { purgeOldJournals } from "./journalRetention.js";
import { syncCrewmeisterPresence } from "./presence.js";
import { isWithinQuietPeriod } from "./quietHours.js";

// Uhrzeit für den täglichen Aufräum-Lauf der Journal-Historie (außerhalb der
// üblichen Arbeitszeit, geringe Last).
const RETENTION_PURGE_TIME = "03:00";

function parseTime(hhmm: string): { h: number; m: number } {
  const [h, m] = hhmm.split(":").map(Number);
  return { h, m };
}

function isWithinWorkHours(workStart: string, workEnd: string): boolean {
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const { h: sh, m: sm } = parseTime(workStart);
  const { h: eh, m: em } = parseTime(workEnd);
  return current >= sh * 60 + sm && current < eh * 60 + em;
}

function isExactMinute(hhmm: string): boolean {
  const now = new Date();
  const { h, m } = parseTime(hhmm);
  return now.getHours() === h && now.getMinutes() === m;
}

/**
 * Zusatz-Filter für die uhrzeitbasierten Regeln (Feierabend-Pause, Arbeitsbeginn-
 * Erinnerung): sie gelten nur für MA, die NICHT über die Zeiterfassung gesteuert
 * werden. Wer eine `crewmeisterUserId` hat und im Auto-Modus läuft
 * (`presenceOverride == null`), wird durch seinen Stempel unterbrochen bzw.
 * erinnert (services/presence.ts) – die Uhrzeit-Regel würde ihn sonst doppelt
 * treffen: mitten in der Arbeit unterbrechen, obwohl er noch eingestempelt ist,
 * und morgens ein zweites Mal erinnern.
 *
 * Ist Crewmeister gar nicht konfiguriert, greifen die Uhrzeit-Regeln wie bisher
 * für alle – sonst gäbe es kein Auffangnetz.
 */
function notClockManagedFilter(): Prisma.AssignmentWhereInput {
  if (!crewmeisterConfigured()) return {};
  return {
    employee: {
      OR: [{ crewmeisterUserId: null }, { presenceOverride: { not: null } }],
    },
  };
}

async function runSchedulerTick() {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  if (!settings) return;

  const { workStart, workEnd, escalationMins, breakStart, breakEnd } = settings;

  // Täglicher Aufräum-Lauf: alte Tagesjournale gemäß Aufbewahrungsdauer löschen.
  if (isExactMinute(RETENTION_PURGE_TIME)) {
    const { deleted } = await purgeOldJournals();
    if (deleted > 0) console.log(`[scheduler] ${deleted} alte Journal-Läufe entfernt`);
  }

  // Feierabend: aktive Zuweisungen pausieren – nur für MA ohne Zeiterfassung,
  // die anderen hat ihr Ausstempeln bereits unterbrochen (siehe presence.ts).
  if (isExactMinute(workEnd)) {
    const active = await prisma.assignment.findMany({
      where: { state: "ACTIVE", ...notClockManagedFilter() },
      select: { id: true, stepId: true, step: { select: { taskId: true } } },
    });
    if (active.length > 0) {
      // Zwei Schritte statt updateMany mit Relations-Filter: den unterstützt
      // updateMany nicht – die IDs stehen oben aber schon fest.
      await prisma.assignment.updateMany({
        where: { id: { in: active.map((a) => a.id) } },
        data: { state: "PAUSED", pausedReason: "END_OF_DAY", pausedAt: new Date() },
      });
      publish("lagerhub", { type: "END_OF_DAY", pausedCount: active.length });
      // Abgeleiteten Status nachziehen (fehlte hier bisher – Dashboard zeigte den
      // Schritt nach der Massen-Pause weiter als laufend, bis etwas anderes ihn anfasste).
      for (const a of active) {
        await afterAssignmentChange(a.stepId, a.step.taskId);
      }
    }
  }

  // Arbeitsbeginn: Erinnerungen für MA mit offenen/pausierten Zuweisungen –
  // ebenfalls nur für MA ohne Zeiterfassung (die anderen erinnert ihr Einstempeln).
  if (isExactMinute(workStart)) {
    const paused = await prisma.assignment.findMany({
      where: { state: "PAUSED", ...notClockManagedFilter() },
      include: {
        employee: true,
        step: { include: { task: true } },
      },
    });

    for (const a of paused) {
      publish("lagerhub", {
        type: "WORK_REMINDER",
        employeeId: a.employeeId,
        employeeName: a.employee.name,
        stepId: a.stepId,
        stepName: a.step.name,
        taskName: a.step.task.name,
      });
    }
  }

  // Eskalation: nur während der Arbeitszeit
  if (!isWithinWorkHours(workStart, workEnd)) return;

  // … und nicht in der Pause (services/quietHours.ts, Zeiten aus den Settings).
  // Der Alarm feuert absichtlich JEDE Minute erneut, solange der Schritt unbesetzt
  // und überfällig ist – er soll drücken, bis jemand übernimmt. Genau das ist in
  // der Pause aber reine Störung: niemand ist da, der übernehmen könnte, und das
  // Handy vibriert 30-mal. Nach der Pause läuft die Eskalation von selbst weiter,
  // sofern der Schritt dann noch liegt – es geht also nichts verloren, es wird nur
  // später gemeldet.
  //
  // Bewusst NUR die Eskalation: die einmaligen Pushs (neue Hoch-Prio-Aufgabe in
  // tasks.ts, neu freigegebener Schritt in assignments.ts) sind kein Spam und
  // sollen auch in der Pause durchkommen.
  if (isWithinQuietPeriod({ breakStart, breakEnd })) return;

  const thresholdMs = escalationMins * 60 * 1000;
  const cutoff = new Date(Date.now() - thresholdMs);

  // Offene (unbesetzte) Schritte von HIGH-Aufgaben, die den Schwellwert überschritten haben
  const staleTasks = await prisma.task.findMany({
    where: { priority: "HIGH", status: "RUNNING", deletedAt: null },
    include: {
      steps: {
        include: {
          skill: true,
          assignments: { where: { state: { in: ["ACTIVE", "PAUSED"] } } },
          predecessors: { include: { predecessor: { include: { assignments: true } } } },
        },
      },
    },
  });

  for (const task of staleTasks) {
    for (const step of task.steps) {
      const hasActive = step.assignments.length > 0;
      if (hasActive) continue;

      // Schritt gesperrt? Dann keine Eskalation
      const allPredsDone = step.predecessors.every((p) =>
        p.predecessor.assignments.some((a) => a.state === "DONE")
      );
      if (!allPredsDone) continue;

      // Referenz für „wie lange offen": der Zeitpunkt, ab dem der Schritt
      // wirklich abholbar war (services/stepAvailability.ts).
      //
      // Früher stand hier ein Behelf – letzter `Assignment.finishedAt` am
      // Schritt, sonst `task.startedAt`, sonst Epoch. Für einen Schritt, der
      // erst spät freigeschaltet wurde, lief die Uhr damit ab Aufgaben-Start:
      // nach zwei Stunden Vorgängerarbeit galt er in der Sekunde seiner Freigabe
      // schon als überfällig. Zusätzlich lieferte `orderBy: finishedAt desc` in
      // Postgres NULLs zuerst, sodass ein offenes Angebot am Schritt die Rechnung
      // ohnehin auf den Fallback kippte.
      //
      // null = noch nie freigegeben (oder Aufgabe nicht im Pool) → nicht eskalieren.
      const openSince = step.availableAt;
      if (!openSince) continue;

      if (openSince < cutoff) {
        // Empfänger: qualifiziert und nicht bereits auf einer HIGH-Aufgabe aktiv –
        // so werden (wie bei Regel 1) auch MA erreicht, die an einem niedriger-
        // prioren Schritt arbeiten und zur überfälligen Aufgabe umschwenken könnten.
        const recipients = await prisma.employee.findMany({
          where: {
            deletedAt: null,
            skills: { some: { skillId: step.skillId } },
            assignments: { none: { state: "ACTIVE", step: { task: { priority: "HIGH" } } } },
          },
        });

        publish("lagerhub", {
          type: "ESCALATION",
          taskId: task.id,
          taskName: task.name,
          stepId: step.id,
          stepName: step.name,
          openSinceMs: Date.now() - openSince.getTime(),
          freeEmployeeIds: recipients.map((e) => e.id),
        });

        // Push an qualifizierte MA (best effort)
        await sendPushToEmployees(
          recipients.map((e) => e.id),
          {
            title: `Eskalation: ${task.name}`,
            body: `Schritt „${step.name}" ist überfällig`,
            data: { taskId: task.id, stepId: step.id },
          }
        );
      }
    }
  }
}

// Anwesenheit aus Crewmeister synchronisieren (best effort, eigener Fehlerpfad,
// damit ein Crewmeister-Problem die übrigen Scheduler-Aufgaben nicht stört).
function runPresenceSync() {
  syncCrewmeisterPresence()
    .then((res) => {
      if (res && res.changed > 0) console.log(`[presence] ${res.changed} Anwesenheit(en) aktualisiert`);
    })
    .catch((err) => console.error("[presence] Fehler:", err.message));
}

export function startScheduler() {
  // Minütlich prüfen
  cron.schedule("* * * * *", () => {
    runSchedulerTick().catch((err) =>
      console.error("[scheduler] Fehler:", err.message)
    );
    // Anwesenheits-Sync läuft unabhängig (auch außerhalb der Arbeitszeit, da MA
    // vor Arbeitsbeginn einstempeln).
    runPresenceSync();
  });

  // Einmal beim Start aufräumen (falls der Server zur 03:00-Marke nicht lief).
  purgeOldJournals()
    .then(({ deleted }) => {
      if (deleted > 0) console.log(`[scheduler] Start-Cleanup: ${deleted} alte Journal-Läufe entfernt`);
    })
    .catch((err) => console.error("[scheduler] Cleanup-Fehler:", err.message));

  // Anwesenheit direkt beim Start einmal abgleichen (nicht erst zur nächsten Minute).
  runPresenceSync();

  console.log("[scheduler] gestartet");
}
