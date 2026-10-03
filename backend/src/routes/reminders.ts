// Erinnerungen: wiederkehrende Dinge, an die jemand denken muss (Wartung,
// Prüfung, Bestellung). Fällige Erinnerungen stehen als Banner im Dashboard;
// dort entscheidet jemand namentlich, was damit geschieht – erledigt,
// verschoben, in den Pool gegeben oder hinfällig. Jede Entscheidung wird als
// ReminderEvent festgehalten und erscheint im Tagesjournal.
//
// Bewusst OHNE Scheduler: Erinnerungen sind tagesgenau (siehe
// services/reminders.ts), fällig ist alles mit dueDate <= heute. Eine
// überfällige Erinnerung verschwindet damit nie von selbst.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { authDashboard, authManager } from "../auth.js";
import { markAvailableSteps } from "../services/stepAvailability.js";
import { topTaskOrderIndex } from "./tasks.js";
import {
  computeNextDue,
  postponeDate,
  startOfLocalDay,
  MAX_POSTPONE_DAYS,
} from "../services/reminders.js";

const RepeatSchema = z.object({
  repeatRule: z.enum(["NONE", "DAILY", "WEEKLY", "MONTHLY", "INTERVAL"]).default("NONE"),
  intervalDays: z.number().int().positive().max(365).nullable().default(null),
  weekday: z.number().int().min(0).max(6).nullable().default(null),
  dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
});

const CreateSchema = RepeatSchema.extend({
  title: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  // "YYYY-MM-DD" – erste Fälligkeit.
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  skillId: z.string().uuid().nullable().default(null),
});

const UpdateSchema = CreateSchema.partial().extend({
  active: z.boolean().optional(),
});

const DecideSchema = z.object({
  decision: z.enum(["DONE", "POSTPONED", "POOLED", "OBSOLETE"]),
  // Nur bei POSTPONED ausgewertet.
  days: z.number().int().min(1).max(MAX_POSTPONE_DAYS).optional(),
});

// "YYYY-MM-DD" → lokale Mitternacht (gleiche Tagesgrenze wie im übrigen System).
function parseDay(value: string): Date {
  return startOfLocalDay(new Date(`${value}T00:00:00`));
}

const reminderInclude = {
  skill: { select: { id: true, name: true } },
  task: { select: { id: true, name: true, poolEnabled: true, deletedAt: true } },
} as const;

export const reminderRoutes: FastifyPluginAsync = async (app) => {
  // Lesen und Entscheiden dürfen alle Dashboard-Rollen (auch das Büro) – die
  // Entscheidung wird ohnehin namentlich protokolliert. Anlegen und Ändern
  // bleibt bei MANAGER/ADMIN.
  app.addHook("preHandler", authDashboard);

  // Alle Erinnerungen (Tab). Aktive zuerst, danach nach Fälligkeit.
  app.get("/", async () => {
    return prisma.reminder.findMany({
      where: { deletedAt: null },
      include: reminderInclude,
      orderBy: [{ active: "desc" }, { dueDate: "asc" }],
    });
  });

  // Fällige Erinnerungen (Banner): heute oder früher, aktiv, nicht gelöscht.
  app.get("/due", async () => {
    const morgen = startOfLocalDay();
    morgen.setDate(morgen.getDate() + 1);
    return prisma.reminder.findMany({
      where: { deletedAt: null, active: true, dueDate: { lt: morgen } },
      include: reminderInclude,
      orderBy: { dueDate: "asc" },
    });
  });

  app.post("/", { preHandler: [authManager] }, async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const reminder = await prisma.reminder.create({
      data: { ...body, dueDate: parseDay(body.dueDate) },
      include: reminderInclude,
    });
    publish("lagerhub", { type: "REMINDER_UPDATED", reminderId: reminder.id });
    return reply.status(201).send(reminder);
  });

  app.patch("/:id", { preHandler: [authManager] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateSchema.parse(req.body);
    const { dueDate, ...rest } = body;
    const reminder = await prisma.reminder.update({
      where: { id },
      data: { ...rest, ...(dueDate ? { dueDate: parseDay(dueDate) } : {}) },
      include: reminderInclude,
    });
    publish("lagerhub", { type: "REMINDER_UPDATED", reminderId: id });
    return reminder;
  });

  // Soft-Delete wie bei Aufgaben/Mitarbeitern: die Erinnerung verschwindet aus
  // Tab und Banner, ihre Journal-Einträge bleiben lesbar (ReminderEvent hält den
  // Titel als eigenen Snapshot).
  app.delete("/:id", { preHandler: [authManager] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.reminder.update({
      where: { id },
      data: { deletedAt: new Date(), active: false },
    });
    publish("lagerhub", { type: "REMINDER_UPDATED", reminderId: id });
    return reply.status(204).send();
  });

  // Entscheidung über eine fällige Erinnerung.
  app.post("/:id/decide", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { decision, days } = DecideSchema.parse(req.body);

    const reminder = await prisma.reminder.findFirst({
      where: { id, deletedAt: null },
      include: reminderInclude,
    });
    if (!reminder) {
      return reply.status(404).send({ error: "Erinnerung nicht gefunden" });
    }

    // Wer entscheidet, steht im Token – nicht im Body. ADMIN hat keine
    // Mitarbeiter-Zeile (geheime PIN), deshalb wird der NAME gespeichert und die
    // id nur, wenn es eine echte gibt.
    const decidedByName = req.user.name;
    const decidedById = req.user.sub === "admin" ? null : req.user.sub;

    let pooledTaskId: string | null = null;

    if (decision === "POOLED") {
      if (!reminder.skillId) {
        return reply.status(400).send({
          error:
            "Ohne Fähigkeit kann die Erinnerung nicht in den Pool – es wäre niemand qualifiziert",
        });
      }
      pooledTaskId = await ensurePooledTask(
        reminder.id,
        reminder.title,
        reminder.skillId,
        reminder.taskId,
      );
    }

    // Nächster Termin: Verschieben setzt nur diesen einen Termin um (der Takt
    // bleibt unberührt), alle anderen Entscheidungen takten weiter. Ohne
    // Folgetermin (einmalige Erinnerung) ist sie abgeschlossen → inaktiv.
    const naechste = decision === "POSTPONED" ? postponeDate(days ?? 1) : computeNextDue(reminder);

    await prisma.$transaction([
      prisma.reminderEvent.create({
        data: {
          reminderId: reminder.id,
          reminderTitle: reminder.title,
          decision,
          decidedByName,
          decidedById,
          postponedTo: decision === "POSTPONED" ? naechste : null,
        },
      }),
      prisma.reminder.update({
        where: { id: reminder.id },
        data: naechste ? { dueDate: naechste } : { active: false },
      }),
    ]);

    publish("lagerhub", { type: "REMINDER_UPDATED", reminderId: reminder.id, decision });
    // Die Entscheidung steht im Tagesjournal – Dashboard und Historie neu laden.
    publish("lagerhub", { type: "JOURNAL_UPDATED" });
    if (pooledTaskId) {
      publish("lagerhub", { type: "TASK_RESTARTED", taskId: pooledTaskId });
    }

    return prisma.reminder.findUnique({ where: { id: reminder.id }, include: reminderInclude });
  });
};

/**
 * Sorgt für die Aufgabe, die zu einer Erinnerung im Pool steht, und stellt sie
 * hinein.
 *
 * Die Aufgabe wird beim ERSTEN "Pool" angelegt und danach wiederverwendet
 * (`Reminder.taskId`) – sonst entstünde bei jedem Takt eine neue Aufgabe im
 * Aufgaben-Tab. Sie hat genau einen Schritt mit der Fähigkeit der Erinnerung;
 * damit greifen Pool-Filter, Fähigkeits-Prüfung, Zeitbuchung und Tagesjournal
 * unverändert, ohne dass Erinnerungen einen eigenen Arbeits-Weg brauchen.
 */
async function ensurePooledTask(
  reminderId: string,
  title: string,
  skillId: string,
  bestehendeTaskId: string | null,
): Promise<string> {
  const skill = await prisma.skill.findUniqueOrThrow({ where: { id: skillId } });

  // Bestehende Aufgabe weiterverwenden, sofern sie nicht gelöscht wurde.
  if (bestehendeTaskId) {
    const vorhanden = await prisma.task.findFirst({
      where: { id: bestehendeTaskId, deletedAt: null },
      select: { id: true },
    });
    if (vorhanden) {
      // Wie "Starten" im Aufgaben-Tab: Alt-Zuweisungen weg, Timer/Notizen
      // zurücksetzen, in den Pool. Das Stempeln der Verfügbarkeits-Uhr kommt
      // DANACH (Reihenfolge wie in tasks.ts /restart – sonst löscht das
      // Zurücksetzen die gerade gesetzten Zeitpunkte wieder).
      await prisma.$transaction([
        prisma.assignment.deleteMany({ where: { step: { taskId: vorhanden.id } } }),
        prisma.step.updateMany({
          where: { taskId: vorhanden.id },
          data: { startedAt: null, notes: [], availableAt: null },
        }),
        prisma.task.update({
          where: { id: vorhanden.id },
          data: { status: "OPEN", startedAt: null, finishedAt: null, poolEnabled: true },
        }),
      ]);
      await markAvailableSteps(vorhanden.id);
      return vorhanden.id;
    }
  }

  // Neu anlegen. Task.name ist eindeutig – bei Namensgleichheit durchzählen,
  // statt mit einem 409 zu scheitern: der Entscheidende hat hier gar keinen
  // Namen eingegeben, den er korrigieren könnte.
  const name = await freierAufgabenname(title);
  const task = await prisma.task.create({
    data: {
      name,
      priority: "MEDIUM",
      poolEnabled: true,
      orderIndex: await topTaskOrderIndex(),
      steps: {
        create: [{ name: skill.name, description: title, skillId, orderIndex: 0 }],
      },
    },
    select: { id: true },
  });

  await prisma.reminder.update({ where: { id: reminderId }, data: { taskId: task.id } });
  await markAvailableSteps(task.id);
  return task.id;
}

async function freierAufgabenname(basis: string): Promise<string> {
  const belegt = await prisma.task.findMany({
    where: { name: { startsWith: basis }, deletedAt: null },
    select: { name: true },
  });
  const namen = new Set(belegt.map((t) => t.name));
  if (!namen.has(basis)) return basis;
  for (let i = 2; i <= 50; i++) {
    const kandidat = `${basis} (${i})`;
    if (!namen.has(kandidat)) return kandidat;
  }
  return `${basis} (${Date.now()})`;
}
