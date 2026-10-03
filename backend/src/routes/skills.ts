import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { authDashboard, authManager } from "../auth.js";

const CreateSkillSchema = z.object({ name: z.string().min(1) });
const UpdateSkillSchema = z.object({ name: z.string().min(1) });

export const skillRoutes: FastifyPluginAsync = async (app) => {
  // Lesen: Aufgaben-/Mitarbeiter-Tab (Dashboard). Verwalten: Manager/Admin.
  app.get("/", { preHandler: [authDashboard] }, async () => {
    return prisma.skill.findMany({ orderBy: { name: "asc" } });
  });

  app.post("/", { preHandler: [authManager] }, async (req, reply) => {
    const { name } = CreateSkillSchema.parse(req.body);

    // Bestehende Fähigkeit wiederverwenden statt Fehler werfen
    const skill = await prisma.skill.upsert({
      where: { name },
      create: { name },
      update: {},
    });

    publish("lagerhub", { type: "SKILL_CREATED", skill });
    return reply.status(201).send(skill);
  });

  // Fähigkeit umbenennen. Konzept: Fähigkeitsname = Schrittname (1:1) →
  // betroffene Schritte werden im selben Transaktion mit umbenannt.
  app.patch("/:id", { preHandler: [authManager] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = UpdateSkillSchema.parse(req.body);

    try {
      const skill = await prisma.$transaction(async (tx) => {
        const updated = await tx.skill.update({ where: { id }, data: { name } });
        await tx.step.updateMany({ where: { skillId: id }, data: { name } });
        return updated;
      });

      publish("lagerhub", { type: "SKILL_UPDATED", skill });
      return skill;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // Unique-Verletzung: Name bereits vergeben
        if (err.code === "P2002") {
          return reply.status(409).send({ error: "Fähigkeit mit diesem Namen existiert bereits" });
        }
        // Datensatz nicht gefunden
        if (err.code === "P2025") {
          return reply.status(404).send({ error: "Fähigkeit nicht gefunden" });
        }
      }
      throw err;
    }
  });

  // Fähigkeit löschen. Von Schritten benutzte Fähigkeiten sind gesperrt
  // (Step.skill = Restrict); Mitarbeiter-Zuordnungen werden via Cascade entfernt.
  // Nur Schritte SICHTBARER (nicht soft-gelöschter) Aufgaben blockieren – die
  // Fehlermeldung nennt sie konkret. Schritte bereits gelöschter Aufgaben sind
  // unsichtbarer Ballast und werden beim Löschen still mit aufgeräumt, damit die
  // FK-Sperre nicht grundlos greift.
  app.delete("/:id", { preHandler: [authManager] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    const skill = await prisma.skill.findUnique({ where: { id } });
    if (!skill) return reply.status(404).send({ error: "Fähigkeit nicht gefunden" });

    const steps = await prisma.step.findMany({
      where: { skillId: id },
      select: { id: true, name: true, task: { select: { name: true, deletedAt: true } } },
    });
    const blocking = steps.filter((s) => s.task && s.task.deletedAt === null);
    const orphaned = steps.filter((s) => !s.task || s.task.deletedAt !== null);

    if (blocking.length > 0) {
      const list = blocking.map((s) => `„${s.task!.name}" → Schritt „${s.name}"`).join(", ");
      return reply.status(409).send({
        error: `Fähigkeit „${skill.name}" wird verwendet von: ${list}. Bitte zuerst dort entfernen.`,
      });
    }

    try {
      await prisma.$transaction(async (tx) => {
        if (orphaned.length > 0) {
          await tx.step.deleteMany({ where: { id: { in: orphaned.map((s) => s.id) } } });
        }
        await tx.skill.delete({ where: { id } });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") {
        return reply.status(404).send({ error: "Fähigkeit nicht gefunden" });
      }
      throw err;
    }

    publish("lagerhub", { type: "SKILL_DELETED", skillId: id });
    return reply.status(204).send();
  });
};
