import type { FastifyPluginAsync } from "fastify";
import { randomInt } from "node:crypto";
import { z } from "zod";
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { crewmeisterConfigured, getMembers, CrewmeisterError } from "../services/crewmeister.js";
import { handlePresenceTransition, syncCrewmeisterPresence } from "../services/presence.js";
import { adminForPin, isAdminPin } from "../adminPins.js";
import { authDashboard, authManager } from "../auth.js";
import { loginRateLimit } from "../loginRateLimit.js";

const RoleSchema = z.enum(["MANAGER", "OFFICE", "WORKER"]);

const CreateEmployeeSchema = z.object({
  name: z.string().min(1),
  skillIds: z.array(z.string().uuid()).default([]),
  // Anwesenheit: standardmäßig anwesend (true).
  present: z.boolean().default(true),
  // Rolle steuert die Oberfläche (Dashboard voll/abgespeckt/PWA), nicht die
  // Einsetzbarkeit. Standard: Lager-MA (WORKER).
  role: RoleSchema.default("WORKER"),
});

const UpdateEmployeeSchema = z.object({
  name: z.string().min(1).optional(),
  skillIds: z.array(z.string().uuid()).optional(),
  present: z.boolean().optional(),
  role: RoleSchema.optional(),
  // Crewmeister-Zuordnung: positive userId setzen oder null zum Lösen.
  crewmeisterUserId: z.number().int().positive().nullable().optional(),
  // Anwesenheits-Steuerquelle: true/false = manuell pinnen, null = zurück auf Auto
  // (Crewmeister-Sync übernimmt wieder).
  presenceOverride: z.boolean().nullable().optional(),
});

// Generiert einen eindeutigen 4-stelligen PIN. crypto.randomInt statt Math.random:
// die PIN ist ein Anmelde-Geheimnis, daher kryptografisch gezogen (nicht vorhersagbar).
async function generatePin(): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const pin = String(randomInt(1000, 10000)); // [1000, 9999]
    if (isAdminPin(pin)) continue; // für Admin-Zugang reservierte PIN nicht vergeben
    const exists = await prisma.employee.findUnique({ where: { pin } });
    if (!exists) return pin;
  }
  throw new Error("Kein freier PIN mehr verfügbar");
}

// Mitarbeiter mit Live-Status anreichern
async function withLiveStatus(employees: Awaited<ReturnType<typeof findAllEmployees>>) {
  const activeAssignments = await prisma.assignment.findMany({
    relationLoadStrategy: "join",
    where: { state: "ACTIVE" },
    include: { step: { include: { task: true } } },
  });

  const activeByEmployee = new Map(activeAssignments.map((a) => [a.employeeId, a]));

  return employees.map((e) => {
    const active = activeByEmployee.get(e.id);
    return {
      ...e,
      status: active ? "active" : "free",
      currentStep: active
        ? { stepId: active.stepId, stepName: active.step.name, taskName: active.step.task.name }
        : null,
    };
  });
}

async function findAllEmployees() {
  return prisma.employee.findMany({
    relationLoadStrategy: "join",
    where: { deletedAt: null },
    include: { skills: { include: { skill: true } } },
    orderBy: { name: "asc" },
  });
}

export const employeeRoutes: FastifyPluginAsync = async (app) => {
  // Liste: Dashboard-PoolTab (Kandidaten/Tacho) + Mitarbeiter-Tab.
  // Der Klartext-PIN ist ein Anmelde-Geheimnis und wird NUR an MANAGER/ADMIN
  // ausgeliefert. OFFICE lädt diese Liste zwar (für Tacho/Kandidaten im Dashboard),
  // zeigt aber keine PIN-Spalte – ohne diese Filterung käme der PIN über die API
  // trotzdem mit und ließe sich zum Anmelden als beliebiger MA missbrauchen.
  app.get("/", { preHandler: [authDashboard] }, async (req) => {
    const employees = await withLiveStatus(await findAllEmployees());
    const maySeePins = req.user.role === "MANAGER" || req.user.role === "ADMIN";
    if (maySeePins) return employees;
    return employees.map(({ pin: _pin, ...rest }) => rest);
  });

  app.post("/", { preHandler: [authManager] }, async (req, reply) => {
    const { name, skillIds, present, role } = CreateEmployeeSchema.parse(req.body);
    const pin = await generatePin();

    const employee = await prisma.employee.create({
      data: {
        name,
        pin,
        present,
        role,
        skills: { create: skillIds.map((skillId) => ({ skillId })) },
      },
      include: { skills: { include: { skill: true } } },
    });

    publish("lagerhub", { type: "EMPLOYEE_CREATED", employee });
    return reply.status(201).send(employee);
  });

  app.patch("/:id", { preHandler: [authManager] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateEmployeeSchema.parse(req.body);

    // Anwesenheit VOR der Änderung merken – der Nachlauf unten hängt am echten
    // Wechsel, nicht am bloßen Speichern.
    const before = await prisma.employee.findUnique({
      where: { id },
      select: { present: true },
    });

    const employee = await prisma.$transaction(async (tx) => {
      if (body.skillIds !== undefined) {
        await tx.employeeSkill.deleteMany({ where: { employeeId: id } });
        await tx.employeeSkill.createMany({
          data: body.skillIds.map((skillId) => ({ employeeId: id, skillId })),
        });
      }
      return tx.employee.update({
        where: { id },
        data: {
          ...(body.name ? { name: body.name } : {}),
          ...(body.present !== undefined ? { present: body.present } : {}),
          ...(body.role !== undefined ? { role: body.role } : {}),
          ...(body.crewmeisterUserId !== undefined ? { crewmeisterUserId: body.crewmeisterUserId } : {}),
          ...(body.presenceOverride !== undefined ? { presenceOverride: body.presenceOverride } : {}),
        },
        include: { skills: { include: { skill: true } } },
      });
    });

    publish("lagerhub", { type: "EMPLOYEE_UPDATED", employee });

    // Manuell auf ab-/anwesend gestellt → dieselbe Folge wie beim Stempeln:
    // abwesend unterbricht die laufende Arbeit (sonst liefe die Uhr weiter,
    // obwohl der MA weg ist), anwesend erinnert an die unterbrochenen Schritte.
    // Best effort: ein Fehler im Nachlauf darf das Speichern nicht scheitern lassen.
    if (before && before.present !== employee.present) {
      try {
        await handlePresenceTransition(id, employee.present);
      } catch (err) {
        console.error(`[employees] Anwesenheits-Nachlauf fehlgeschlagen:`, (err as Error).message);
      }
    }

    // Zurück auf Auto gestellt → Anwesenheit sofort aus Crewmeister neu berechnen
    // (best effort, fire-and-forget; das EMPLOYEE_UPDATED aus dem Sync aktualisiert
    // die Clients). Nicht awaiten, damit die Antwort nicht an Crewmeister hängt.
    // Der Sync erkennt einen dadurch entstehenden Wechsel selbst und unterbricht
    // bzw. erinnert – deshalb hier kein zweiter Aufruf.
    if (body.presenceOverride === null) {
      void syncCrewmeisterPresence().catch(() => {});
    }

    return employee;
  });

  // Dashboard-PIN-Login: nur Identifikation für die Manager-/Büro-Oberfläche.
  // Bindet bewusst KEIN Gerät (anders als /login für die PWA) – das Dashboard
  // läuft oft auf einem geteilten PC, an dem sich mehrere Manager/Büro-Kräfte
  // nacheinander anmelden. Liefert Rolle + Name; die Tab-Sichtbarkeit ergibt sich
  // im Frontend daraus. Hinweis: noch keine echte Absicherung (kein Token) – das
  // kommt mit dem Auth-Konzept zur PWA-Phase; vorerst reine Komfort-Filterung.
  app.post("/pin-login", { preHandler: [loginRateLimit] }, async (req, reply) => {
    const { pin } = z.object({ pin: z.string().length(4) }).parse(req.body);

    // Geheime Admin-PIN (aus .env, kein Mitarbeiter-Datensatz) → Vollansicht.
    const admin = adminForPin(pin);
    if (admin) {
      const token = app.jwt.sign({ sub: "admin", role: "ADMIN", name: admin.name });
      return { id: "admin", name: admin.name, role: "ADMIN", token };
    }

    const employee = await prisma.employee.findUnique({
      where: { pin },
      select: { id: true, name: true, role: true, deletedAt: true },
    });
    if (!employee || employee.deletedAt) {
      return reply.status(401).send({ error: "Ungültiger PIN" });
    }

    const token = app.jwt.sign({ sub: employee.id, role: employee.role, name: employee.name });
    return { id: employee.id, name: employee.name, role: employee.role, token };
  });

  // PIN-Login: Gerät binden oder vertrauen
  app.post("/login", { preHandler: [loginRateLimit] }, async (req, reply) => {
    const { pin, deviceId } = z
      .object({ pin: z.string().length(4), deviceId: z.string().min(1) })
      .parse(req.body);

    const employee = await prisma.employee.findUnique({ where: { pin } });
    // Gelöschte (Soft-Delete) MA dürfen sich nicht anmelden – PIN gilt als ungültig.
    if (!employee || employee.deletedAt) return reply.status(401).send({ error: "Ungültiger PIN" });

    // Gerät bereits einem anderen MA zugeordnet
    if (employee.deviceId && employee.deviceId !== deviceId && employee.deviceTrusted) {
      return reply.status(403).send({ error: "Gerät nicht autorisiert" });
    }

    const updated = await prisma.employee.update({
      where: { id: employee.id },
      data: { deviceId, deviceTrusted: true },
      include: { skills: { include: { skill: true } } },
    });

    const token = app.jwt.sign({ sub: updated.id, role: updated.role, name: updated.name });
    return { ...updated, token };
  });

  // Crewmeister-Mitglieder für die manuelle MA-Zuordnung (Dropdown im Dashboard):
  // [{ userId, name, email, disabled }]. Liefert 503 mit Grund, wenn Crewmeister
  // nicht konfiguriert oder gerade nicht erreichbar ist (UI zeigt dann einen Hinweis).
  app.get("/crewmeister-members", { preHandler: [authManager] }, async (_req, reply) => {
    if (!crewmeisterConfigured()) {
      return reply.status(503).send({ error: "Crewmeister ist nicht konfiguriert" });
    }
    try {
      return await getMembers();
    } catch (err) {
      const message = err instanceof CrewmeisterError ? err.message : "Crewmeister nicht erreichbar";
      return reply.status(503).send({ error: message });
    }
  });

  // Geräte-Reset durch Manager
  app.post("/:id/reset-device", { preHandler: [authManager] }, async (req) => {
    const { id } = req.params as { id: string };

    const employee = await prisma.employee.update({
      where: { id },
      data: { deviceId: null, deviceTrusted: false },
    });

    publish("lagerhub", { type: "EMPLOYEE_DEVICE_RESET", employeeId: id });
    return employee;
  });

  // Mitarbeiter löschen (Soft-Delete: setzt deletedAt). Gesperrt, solange der MA
  // aktiv an einem Schritt arbeitet (sonst würde ein laufender Schritt unbemerkt
  // unterbesetzt). Der MA verschwindet aus Listen/Login/Push; seine Skills, Geräte-
  // bindung und Push-Abos werden gelöst, die historischen Zuweisungen
  // (Statistik/TaskRun) bleiben erhalten. Bereits gelöschte MA gelten als nicht gefunden.
  app.delete("/:id", { preHandler: [authManager] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const employee = await prisma.employee.findUnique({ where: { id } });
    if (!employee || employee.deletedAt) {
      return reply.status(404).send({ error: "Mitarbeiter nicht gefunden" });
    }

    const activeCount = await prisma.assignment.count({
      where: { employeeId: id, state: "ACTIVE" },
    });
    if (activeCount > 0) {
      return reply.status(409).send({
        error: "Mitarbeiter arbeitet gerade aktiv an einem Schritt und kann nicht gelöscht werden",
      });
    }

    await prisma.$transaction([
      // Soft-Delete-Marke setzen und Gerätebindung lösen (kann sich nicht mehr anmelden)
      prisma.employee.update({
        where: { id },
        data: { deletedAt: new Date(), deviceId: null, deviceTrusted: false },
      }),
      // Skill-Zuordnungen und Push-Abos entfernen (für Pool-Filter / Push irrelevant)
      prisma.employeeSkill.deleteMany({ where: { employeeId: id } }),
      prisma.pushSubscription.deleteMany({ where: { employeeId: id } }),
    ]);

    publish("lagerhub", { type: "EMPLOYEE_DELETED", employeeId: id });
    return reply.status(204).send();
  });
};
