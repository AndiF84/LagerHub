import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { deriveStepStatus } from "../services/stepStatus.js";
import { authAny } from "../auth.js";

export const poolRoutes: FastifyPluginAsync = async (app) => {
  // PWA (WORKER) UND Dashboard-PoolTab → authAny (jedes gültige Token).
  app.addHook("preHandler", authAny);

  // Alle offenen Pool-Schritte, optional gefiltert nach Fähigkeit oder Mitarbeiter
  app.get("/", async (req) => {
    const { skillId, employeeId: queryEmployeeId } = z
      .object({
        skillId: z.string().uuid().optional(),
        employeeId: z.string().uuid().optional(),
      })
      .parse(req.query);

    // Ein WORKER (PWA) sieht ausschließlich seinen EIGENEN Pool: employeeId wird
    // aus dem Token erzwungen, der Query-Wert ignoriert (kein Ausspähen anderer).
    // Dashboard-Rollen (OFFICE/MANAGER/ADMIN) dürfen ungefiltert sehen bzw. gezielt
    // einen MA vorschauen – für sie gilt der Query-Wert.
    const employeeId = req.user.role === "WORKER" ? req.user.sub : queryEmployeeId;

    // Fähigkeiten des Mitarbeiters für automatische Filterung
    let skillIds: string[] | undefined;
    if (employeeId) {
      const empSkills = await prisma.employeeSkill.findMany({ where: { employeeId } });
      skillIds = empSkills.map((s) => s.skillId);
    } else if (skillId) {
      skillIds = [skillId];
    }

    // EINE Abfrage liefert alles: Anzeige-Daten UND die zur Status-Ableitung
    // nötigen Relationen (alle Assignment-States + Vorgänger samt deren
    // Assignments). Dadurch entfällt die früher separate Status-Abfrage
    // (zweite Transaktion = ~5-6 zusätzliche DB-Roundtrips).
    const tasks = await prisma.task.findMany({
      // Relationen als EIN SQL-Statement mit JOINs laden statt vieler SELECTs.
      relationLoadStrategy: "join",
      where: { poolEnabled: true, status: { not: "COMPLETED" }, deletedAt: null },
      // Feste Reihenfolge. Beide Clients (PWA-Arbeitsansicht, Dashboard-PoolTab)
      // sortieren nur nach Priorität und verlassen sich darauf, dass der stabile
      // Array.sort bei gleicher Priorität "die Pool-Reihenfolge" erhält – ohne
      // orderBy wäre das die ungeordnete Rückgabe von Postgres, die sich nach
      // einem Update an einer Zeile ändern kann (Karten tauschen die Plätze).
      // Zuerst die Reihenfolge aus dem Aufgaben-Tab (orderIndex), dann `name` –
      // eindeutig → totale Ordnung, kein Rest-Wackeln.
      orderBy: [{ orderIndex: "asc" }, { name: "asc" }],
      include: {
        steps: {
          where: skillIds ? { skillId: { in: skillIds } } : {},
          orderBy: { orderIndex: "asc" },
          include: {
            skill: true,
            // ALLE States laden – die Status-Ableitung braucht u. a. DONE; für
            // die Anzeige wird unten in JS auf ACTIVE/PAUSED/OFFERED gefiltert.
            assignments: { include: { employee: true } },
            predecessors: {
              include: {
                predecessor: {
                  select: { minWorkers: true, assignments: { select: { state: true } } },
                },
              },
            },
          },
        },
      },
    });

    // Nicht gesperrte Schritte zurückgeben (LOCKED erscheint nie im Pool).
    // ERLEDIGTE Schritte fahren mit – nur zur Anzeige/Notiz-Bearbeitung, nicht
    // als bearbeitbare Arbeit. Zusätzlich den Fortschritt (erledigte / gesamt)
    // zählen.
    const result = [];
    for (const task of tasks) {
      const steps = [];
      let doneCount = 0;
      let openCount = 0;
      for (const step of task.steps) {
        const status = deriveStepStatus(step);
        if (status === "LOCKED") continue;
        if (status === "DONE") doneCount++;
        else openCount++;
        // Für die Anzeige nur relevante Zuweisungen (Ableitung nutzte alle);
        // bei DONE bleibt das leer (keine ACTIVE/PAUSED/OFFERED mehr).
        const assignments = step.assignments.filter(
          (a) => a.state === "ACTIVE" || a.state === "PAUSED" || a.state === "OFFERED",
        );
        steps.push({ ...step, assignments, computedStatus: status });
      }
      // Aufgabe nur listen, wenn es offene (bearbeitbare) Schritte gibt; reine
      // DONE-Schritte lösen keine Listung aus (so eine Aufgabe ist ohnehin
      // bereits abgeschlossen/finalisiert).
      if (openCount > 0) {
        result.push({
          ...task,
          steps,
          stepsTotal: task.steps.length,
          stepsDone: doneCount,
        });
      }
    }

    return result;
  });
};
