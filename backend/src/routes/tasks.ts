import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { notifyHighPriorityTask, sendPushToEmployees } from "../services/push.js";
import { markAvailableSteps, clearAvailability } from "../services/stepAvailability.js";
import { authDashboard } from "../auth.js";

const StepInputSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  minWorkers: z.number().int().positive().nullable().default(null),
  maxWorkers: z.number().int().positive().nullable().default(null),
  predecessorIndices: z.array(z.number().int().nonnegative()).default([]),
  noteRequired: z.boolean().default(false),
  noteFormat: z.enum(["TEXT", "NUMBER"]).default("TEXT"),
  noteLabel: z.string().max(80).default(""),
});

const CreateTaskSchema = z.object({
  name: z.string().min(1),
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]).default("MEDIUM"),
  steps: z.array(StepInputSchema).default([]),
});

const UpdateTaskSchema = z.object({
  priority: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
  poolEnabled: z.boolean().optional(),
  repeat: z.boolean().optional(),
  name: z.string().min(1).optional(),
});

// Wird auch innerhalb von Transaktionen aufgerufen: Beim Lesen frisch
// erzeugter Datensätze muss derselbe Transaktions-Client verwendet werden,
// sonst sieht der globale Client (anderer Pool-Connection) die Daten nicht.
async function getTaskWithSteps(id: string, client: Prisma.TransactionClient = prisma) {
  return client.task.findUniqueOrThrow({
    // Relationen als EIN SQL-Statement mit JOINs laden statt vieler SELECTs.
    relationLoadStrategy: "join",
    where: { id },
    include: {
      steps: {
        orderBy: { orderIndex: "asc" },
        include: {
          skill: true,
          assignments: { where: { state: { in: ["ACTIVE", "PAUSED"] } }, include: { employee: true } },
          predecessors: { include: { predecessor: true } },
        },
      },
    },
  });
}

// Aufgabe aus dem Pool nehmen: Zuweisungen des laufenden Versuchs entfernen und
// die Aufgabe in DERSELBEN Transaktion umstellen. Atomar, damit zwischen beiden
// Schritten kein MA in einen Schritt einloggen kann, der gleich unerreichbar wird
// (er säße sonst auf einer Zuweisung, die er weder abschließen noch verlassen
// kann – genau der Fehler, den diese Funktion behebt). Der Aufrufer stellt
// sicher, dass noch kein Schritt begonnen wurde; deshalb ist hier keine
// Arbeitszeit im Spiel und Löschen ist verlustfrei.
async function withdrawFromPool(id: string, data: Prisma.TaskUpdateInput) {
  // Interaktive Transaktion (statt der billigeren Array-Form), weil die
  // betroffenen Mitarbeiter VOR dem Löschen gelesen werden müssen – sie sollen
  // erfahren, dass sie ausgeloggt wurden. Der Aufwand ist hier belanglos: das
  // Zurückziehen einer Aufgabe ist eine seltene Einzelaktion.
  return prisma.$transaction(async (tx) => {
    // Nur ACTIVE/PAUSED werden gemeldet: OFFERED ist ein unverbindliches
    // Angebot, das schlicht verfällt – dafür braucht niemand ein Banner.
    const withdrawn = await tx.assignment.findMany({
      where: { step: { taskId: id }, state: { in: ["ACTIVE", "PAUSED"] } },
      select: {
        employeeId: true,
        stepId: true,
        step: { select: { name: true, task: { select: { name: true } } } },
      },
    });
    // Gelöscht wird ALLES (inklusive der Angebote) – die Aufgabe ist ab jetzt
    // nicht mehr abholbar, offene Angebote darauf wären tote Einträge.
    await tx.assignment.deleteMany({ where: { step: { taskId: id } } });
    const task = await tx.task.update({ where: { id }, data });
    return { task, withdrawn };
  });
}

// Ist der Name schon von einer (nicht gelöschten) Aufgabe belegt? Gelöschte
// Aufgaben geben ihren Namen frei (siehe DELETE) und zählen daher nicht mit.
// `exceptId` schließt die eigene Aufgabe beim Umbenennen aus.
async function nameTaken(name: string, exceptId?: string): Promise<boolean> {
  const existing = await prisma.task.findFirst({
    where: { name, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  });
  return existing !== null;
}

// Platz für eine neue Aufgabe im Aufgaben-Tab: ganz oben (kleinster Wert − 1).
// Oben, weil die Liste vor der freien Reihenfolge „neueste zuerst“ war – wer
// eine Aufgabe anlegt, will sie direkt sehen und mit Schritten füllen.
export async function topTaskOrderIndex(
  tx: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<number> {
  const { _min } = await tx.task.aggregate({
    where: { deletedAt: null },
    _min: { orderIndex: true },
  });
  return (_min.orderIndex ?? 1) - 1;
}

export const taskRoutes: FastifyPluginAsync = async (app) => {
  // Aufgaben-Verwaltung = Aufgaben-Tab (OFFICE/MANAGER/ADMIN). Alle Routen dashboard-geschützt.
  app.addHook("preHandler", authDashboard);

  app.get("/", async () => {
    const tasks = await prisma.task.findMany({
      // Relationen als EIN SQL-Statement mit JOINs laden statt vieler SELECTs.
      relationLoadStrategy: "join",
      where: { deletedAt: null },
      // Frei per Drag & Drop (POST /reorder). createdAt nur als Gleichstand-
      // Brecher, falls zwei Aufgaben denselben Wert haben (z. B. gleichzeitig
      // angelegt) – sonst wäre die Reihenfolge die ungeordnete Postgres-Rückgabe.
      orderBy: [{ orderIndex: "asc" }, { createdAt: "desc" }],
      include: {
        steps: {
          orderBy: { orderIndex: "asc" },
          include: {
            skill: true,
            assignments: { where: { state: { in: ["ACTIVE", "PAUSED"] } }, include: { employee: true } },
            predecessors: { include: { predecessor: true } },
          },
        },
      },
    });
    return tasks;
  });

  // Reihenfolge im Aufgaben-Tab setzen (Drag & Drop). Erwartet ALLE nicht
  // gelöschten Aufgaben in der neuen Reihenfolge – wie /steps/reorder; eine
  // Teil-Liste würde die übrigen auf alten, nun kollidierenden Werten lassen.
  app.post("/reorder", async (req, reply) => {
    const { orderedIds } = z.object({ orderedIds: z.array(z.string().min(1)) }).parse(req.body);

    const tasks = await prisma.task.findMany({ where: { deletedAt: null }, select: { id: true } });
    const existing = new Set(tasks.map((t) => t.id));
    const sameSet =
      orderedIds.length === existing.size &&
      new Set(orderedIds).size === orderedIds.length &&
      orderedIds.every((id) => existing.has(id));
    if (!sameSet) {
      // Typisch: jemand hat parallel eine Aufgabe angelegt/gelöscht und die
      // Liste ist veraltet – die Oberfläche lädt nach dem Fehler neu.
      return reply
        .status(409)
        .send({ error: "Die Aufgabenliste hat sich geändert – bitte erneut verschieben" });
    }

    await prisma.$transaction(
      orderedIds.map((id, i) => prisma.task.update({ where: { id }, data: { orderIndex: i } })),
    );

    publish("lagerhub", { type: "TASKS_REORDERED" });
    return reply.status(204).send();
  });

  app.get("/:id", async (req) => {
    const { id } = req.params as { id: string };
    return getTaskWithSteps(id);
  });

  app.post("/", async (req, reply) => {
    const { name, priority, steps: stepInputs } = CreateTaskSchema.parse(req.body);

    if (await nameTaken(name)) {
      return reply.status(409).send({ error: `Eine Aufgabe mit dem Namen "${name}" existiert bereits` });
    }

    const task = await prisma.$transaction(async (tx) => {
      const newTask = await tx.task.create({
        data: { name, priority, orderIndex: await topTaskOrderIndex(tx) },
      });

      const createdSteps = [];
      for (let i = 0; i < stepInputs.length; i++) {
        const s = stepInputs[i];

        // Skill upsert (Schrittname = Fähigkeitsname)
        const skill = await tx.skill.upsert({
          where: { name: s.name },
          create: { name: s.name },
          update: {},
        });

        const step = await tx.step.create({
          data: {
            taskId: newTask.id,
            name: s.name,
            skillId: skill.id,
            description: s.description,
            orderIndex: i,
            minWorkers: s.minWorkers,
            maxWorkers: s.maxWorkers,
            noteRequired: s.noteRequired,
            noteFormat: s.noteFormat,
            noteLabel: s.noteLabel,
          },
        });
        createdSteps.push(step);
      }

      // Vorgänger verknüpfen (nach Index aus dem Input-Array)
      for (let i = 0; i < stepInputs.length; i++) {
        const s = stepInputs[i];
        const predecessorIndices =
          s.predecessorIndices.length > 0
            ? s.predecessorIndices
            : i > 0
              ? [i - 1] // Standard: einfache Kette
              : [];

        for (const pi of predecessorIndices) {
          if (pi < i) {
            await tx.stepPredecessor.create({
              data: { stepId: createdSteps[i].id, predecessorId: createdSteps[pi].id },
            });
          }
        }
      }

      return getTaskWithSteps(newTask.id, tx);
    });

    publish("lagerhub", { type: "TASK_CREATED", task });
    return reply.status(201).send(task);
  });

  app.patch("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = UpdateTaskSchema.parse(req.body);

    if (body.name && (await nameTaken(body.name, id))) {
      return reply
        .status(409)
        .send({ error: `Eine Aufgabe mit dem Namen "${body.name}" existiert bereits` });
    }

    // Vorherige Werte für die Übergangserkennung (nur einmal pushen)
    const before = await prisma.task.findUnique({
      where: { id },
      select: { priority: true, poolEnabled: true, startedAt: true },
    });

    const leavingPool = body.poolEnabled === false && before?.poolEnabled === true;

    // Aus dem Pool nehmen ist nur erlaubt, solange KEIN Schritt begonnen wurde
    // (task.startedAt === null) – dieselbe Regel, die das Dashboard über
    // `removable` schon anzeigt, hier aber verbindlich. Sobald ein Timer lief,
    // hängt an den Zuweisungen echte Arbeitszeit; die dürfen nicht verschwinden.
    if (leavingPool && before?.startedAt != null) {
      return reply.status(409).send({
        error:
          "An dieser Aufgabe wurde bereits gearbeitet – sie kann nicht mehr aus dem Pool genommen werden",
      });
    }

    // Beim Pool-Austritt fahren die Zuweisungen des laufenden Versuchs MIT raus.
    // Ohne das blieb ein MA auf einem Schritt eingeloggt, den er nicht mehr sehen
    // konnte (der Pool filtert auf poolEnabled) – also weder abschließen noch
    // verlassen. Löschen (statt PAUSED) ist hier korrekt und entspricht genau der
    // `leave`-Semantik: es lief kein Schritt-Timer, es ist keine Arbeitszeit
    // gebucht. Offene Angebote (OFFERED) gehen mit weg; ein Angebot auf eine
    // nicht mehr abholbare Aufgabe wäre ohnehin tot.
    const withdrawal = leavingPool ? await withdrawFromPool(id, body) : null;
    const task =
      withdrawal?.task ?? (await prisma.task.update({ where: { id }, data: body }));

    // Regel-1-Push (an qualifizierte MA) in zwei Fällen:
    //  a) Aufgabe wird auf HIGH hochgestuft (Übergang) → zusätzlich das Event.
    //  b) Eine bereits hochpriore Aufgabe wird in den Pool gestellt ("Starten" =
    //     poolEnabled false→true) – sonst käme dabei nie ein Push.
    const becameHigh = body.priority === "HIGH" && before?.priority !== "HIGH";
    const startedHighIntoPool =
      body.poolEnabled === true && before?.poolEnabled !== true && task.priority === "HIGH";

    // Pool-Übergang steuert die „abholbar seit"-Uhr:
    //  rein  → die jetzt offenen Schritte stempeln (Start der Wartezeit),
    //  raus  → Zeitpunkte verwerfen; ein aus dem Pool genommener Schritt ist
    //          nicht abholbar, und beim Wiedereinstellen wäre der alte Wert ein
    //          zu hohes Alter (markAvailableSteps überschreibt bewusst nicht).
    if (body.poolEnabled === true && before?.poolEnabled !== true) {
      await markAvailableSteps(id);
    } else if (leavingPool) {
      await clearAvailability(id);
    }

    if (becameHigh) {
      publish("lagerhub", { type: "TASK_PRIORITY_HIGH", taskId: id });
    }
    // Nur pushen, wenn die Aufgabe auch abholbar ist. `becameHigh` allein reicht
    // nicht: die Status-Ableitung (deriveStepStatus) kennt `poolEnabled` nicht,
    // ein Schritt einer NICHT gestarteten Aufgabe gilt dort als OPEN. Ohne diese
    // Bedingung bekaeme das Lager eine Meldung ueber eine wichtige Aufgabe, die
    // in der App gar nicht auftaucht – `GET /pool` filtert auf poolEnabled.
    // Das Dashboard-Ereignis TASK_PRIORITY_HIGH oben bleibt davon unberuehrt:
    // es ist ein Invalidierungs-Signal, keine Stoerung.
    if ((becameHigh && task.poolEnabled) || startedHighIntoPool) {
      void notifyHighPriorityTask(id);
    }

    // Beim Pool-Austritt sind Zuweisungen verschwunden: TASK_UPDATED allein
    // invalidiert in den Clients nur tasks/pool/stats, nicht die Mitarbeiter-Liste
    // (Live-Status "arbeitet gerade an"). ASSIGNMENT_CHANGED ist dafür das
    // vorgesehene Signal; die 200-ms-Bündelung fasst beide zu einer Refetch-Welle
    // zusammen.
    if (leavingPool) {
      publish("lagerhub", { type: "ASSIGNMENT_CHANGED", taskId: id });
    }

    // Wer gerade ausgeloggt wurde, soll es auch erfahren: Der Schritt
    // verschwindet sonst kommentarlos aus seiner Arbeitsansicht. Ein Event je
    // betroffener Zuweisung (Muster wie WORK_REMINDER – die PWA filtert auf die
    // eigene employeeId) plus ein Push, falls die App gerade nicht offen ist.
    if (withdrawal && withdrawal.withdrawn.length > 0) {
      for (const a of withdrawal.withdrawn) {
        publish("lagerhub", {
          type: "ASSIGNMENT_WITHDRAWN",
          employeeId: a.employeeId,
          stepId: a.stepId,
          stepName: a.step.name,
          taskName: a.step.task.name,
        });
      }

      // Ein Push je MA, nicht je Schritt: wer auf mehreren Schritten derselben
      // Aufgabe saß, soll nicht mehrfach angestupst werden.
      const jeMitarbeiter = new Map<string, string[]>();
      for (const a of withdrawal.withdrawn) {
        const liste = jeMitarbeiter.get(a.employeeId) ?? [];
        liste.push(a.step.name);
        jeMitarbeiter.set(a.employeeId, liste);
      }
      for (const [employeeId, schritte] of jeMitarbeiter) {
        void sendPushToEmployees([employeeId], {
          title: "Aufgabe zurückgezogen",
          body:
            `„${task.name}" wurde aus dem Pool genommen – du bist aus ` +
            schritte.map((n) => `„${n}"`).join(", ") +
            " ausgeloggt.",
        });
      }
    }

    publish("lagerhub", { type: "TASK_UPDATED", task });
    return task;
  });

  // Aufgabe kopieren (gleiche Schrittkette, neuer Name)
  app.post("/:id/copy", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = z.object({ name: z.string().min(1) }).parse(req.body);

    if (await nameTaken(name)) {
      return reply.status(409).send({ error: `Eine Aufgabe mit dem Namen "${name}" existiert bereits` });
    }

    const source = await getTaskWithSteps(id);

    const task = await prisma.$transaction(async (tx) => {
      const newTask = await tx.task.create({
        data: { name, priority: source.priority, orderIndex: await topTaskOrderIndex(tx) },
      });

      const oldToNew = new Map<string, string>();
      for (const s of source.steps) {
        const step = await tx.step.create({
          data: {
            taskId: newTask.id,
            name: s.name,
            skillId: s.skillId,
            description: s.description,
            orderIndex: s.orderIndex,
            minWorkers: s.minWorkers,
            maxWorkers: s.maxWorkers,
            // Pflichtnotiz mitkopieren – eine Kopie soll dieselbe Angabe
            // verlangen wie das Original, sonst geht die Regel still verloren.
            noteRequired: s.noteRequired,
            noteFormat: s.noteFormat,
            noteLabel: s.noteLabel,
          },
        });
        oldToNew.set(s.id, step.id);
      }

      for (const s of source.steps) {
        for (const p of s.predecessors) {
          const newStepId = oldToNew.get(s.id)!;
          const newPredId = oldToNew.get(p.predecessorId)!;
          await tx.stepPredecessor.create({
            data: { stepId: newStepId, predecessorId: newPredId },
          });
        }
      }

      return getTaskWithSteps(newTask.id, tx);
    });

    publish("lagerhub", { type: "TASK_CREATED", task });
    return reply.status(201).send(task);
  });

  // Aufgabe neu starten (nach Abschluss)
  app.post("/:id/restart", async (req) => {
    const { id } = req.params as { id: string };

    const [, , task] = await prisma.$transaction([
      // Alt-Assignments entfernen, sonst leitet sich sofort wieder "erledigt" ab
      prisma.assignment.deleteMany({ where: { step: { taskId: id } } }),
      // Timer, Notiz-Verlauf und Verfügbarkeits-Uhr der Schritte zurücksetzen
      prisma.step.updateMany({
        where: { taskId: id },
        data: { startedAt: null, notes: [], availableAt: null },
      }),
      prisma.task.update({
        where: { id },
        data: { status: "OPEN", startedAt: null, finishedAt: null },
      }),
    ]);

    // Steht die Aufgabe im Pool, sind ihre Eingangs-Schritte ab jetzt abholbar.
    // Bewusst NACH dem Zurücksetzen: "Starten" im Dashboard ist PATCH
    // (poolEnabled=true) + restart – in der umgekehrten Reihenfolge hätte das
    // updateMany oben die gerade gesetzten Zeitpunkte wieder gelöscht.
    if (task.poolEnabled) await markAvailableSteps(id);

    publish("lagerhub", { type: "TASK_RESTARTED", taskId: id });
    return task;
  });

  // Aufgabe löschen (Soft-Delete: setzt deletedAt). Die Aufgabe verschwindet aus
  // Listen/Pool/Stats; die TaskRun-Historie (eigenständiger Snapshot inkl.
  // taskName) bleibt erhalten. Gesperrt, solange ein Schritt aktiv bearbeitet
  // wird (sonst würde laufende Arbeit unbemerkt verworfen). Bereits gelöschte
  // Aufgaben gelten als nicht gefunden.
  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };

    const task = await prisma.task.findUnique({ where: { id } });
    if (!task || task.deletedAt) return reply.status(404).send({ error: "Aufgabe nicht gefunden" });

    const activeCount = await prisma.assignment.count({
      where: { step: { taskId: id }, state: "ACTIVE" },
    });
    if (activeCount > 0) {
      return reply.status(409).send({
        error: "An dieser Aufgabe wird gerade aktiv gearbeitet und sie kann nicht gelöscht werden",
      });
    }

    // Soft-Delete-Marke setzen und aus dem Pool nehmen. Lauf-Assignments des
    // (nicht aktiven) Schritts aufräumen, damit kein PAUSED-Rest hängen bleibt.
    // Den Originalnamen freigeben (mit der eindeutigen id umbenennen), damit eine
    // gleichnamige Aufgabe neu angelegt werden kann. Dieser interne Name ist nie
    // sichtbar (gelöschte Aufgaben sind überall ausgefiltert); die Historie nutzt
    // den TaskRun-Snapshot-Namen, nicht diesen.
    await prisma.$transaction([
      prisma.assignment.deleteMany({ where: { step: { taskId: id } } }),
      prisma.task.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          poolEnabled: false,
          name: `${task.name} (gelöscht ${id})`,
        },
      }),
    ]);

    publish("lagerhub", { type: "TASK_DELETED", taskId: id });
    return reply.status(204).send();
  });
};
