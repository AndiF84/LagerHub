import type { FastifyPluginAsync } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { asNoteArray, makeNoteEntry, noteAuthorFromUser } from "../services/notes.js";
import { authAny, authDashboard } from "../auth.js";

const NoteFormatSchema = z.enum(["TEXT", "NUMBER"]);

const CreateStepSchema = z.object({
  taskId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().default(""),
  minWorkers: z.number().int().positive().nullable().default(null),
  maxWorkers: z.number().int().positive().nullable().default(null),
  predecessorIds: z.array(z.string().uuid()).default([]),
  noteRequired: z.boolean().default(false),
  noteFormat: NoteFormatSchema.default("TEXT"),
  noteLabel: z.string().max(80).default(""),
});

const UpdateStepSchema = z.object({
  description: z.string().optional(),
  minWorkers: z.number().int().positive().nullable().optional(),
  maxWorkers: z.number().int().positive().nullable().optional(),
  predecessorIds: z.array(z.string().uuid()).optional(),
  noteRequired: z.boolean().optional(),
  noteFormat: NoteFormatSchema.optional(),
  noteLabel: z.string().max(80).optional(),
});

const ReorderSchema = z.object({
  taskId: z.string().uuid(),
  // Vollständige neue Reihenfolge aller Schritt-IDs der Aufgabe
  orderedIds: z.array(z.string().uuid()).min(1),
});

const AddNoteSchema = z.object({
  text: z.string().min(1).max(2000),
});

export const stepRoutes: FastifyPluginAsync = async (app) => {
  app.post("/", { preHandler: [authDashboard] }, async (req, reply) => {
    const body = CreateStepSchema.parse(req.body);

    const step = await prisma.$transaction(async (tx) => {
      // Skill upsert
      const skill = await tx.skill.upsert({
        where: { name: body.name },
        create: { name: body.name },
        update: {},
      });

      const maxOrder = await tx.step.aggregate({
        where: { taskId: body.taskId },
        _max: { orderIndex: true },
      });
      const orderIndex = (maxOrder._max.orderIndex ?? -1) + 1;

      // Standard-Vorgänger: letzter vorhandener Schritt
      let predecessorIds = body.predecessorIds;
      if (predecessorIds.length === 0 && orderIndex > 0) {
        const last = await tx.step.findFirst({
          where: { taskId: body.taskId },
          orderBy: { orderIndex: "desc" },
        });
        if (last) predecessorIds = [last.id];
      }

      const step = await tx.step.create({
        data: {
          taskId: body.taskId,
          name: body.name,
          skillId: skill.id,
          description: body.description,
          orderIndex,
          minWorkers: body.minWorkers,
          maxWorkers: body.maxWorkers,
          noteRequired: body.noteRequired,
          noteFormat: body.noteFormat,
          noteLabel: body.noteLabel,
          predecessors: {
            create: predecessorIds.map((predecessorId) => ({ predecessorId })),
          },
        },
        include: { skill: true, predecessors: { include: { predecessor: true } } },
      });

      return step;
    });

    publish("lagerhub", { type: "STEP_CREATED", step });
    return reply.status(201).send(step);
  });

  // Schritte einer Aufgabe neu anordnen. Setzt orderIndex gemäß der übergebenen
  // Reihenfolge. Die "Wartet auf"-Beziehungen (Vorgänger) werden dabei komplett
  // entfernt (geleert) – nach dem Umsortieren wartet kein Schritt mehr auf einen
  // anderen; die Vorgänger lassen sich danach pro Schritt per PATCH /:id neu setzen.
  app.post("/reorder", { preHandler: [authDashboard] }, async (req, reply) => {
    const { taskId, orderedIds } = ReorderSchema.parse(req.body);

    // Vollständigkeit prüfen: genau die Schritte der Aufgabe, keine fremden.
    const steps = await prisma.step.findMany({ where: { taskId }, select: { id: true } });
    const existing = new Set(steps.map((s) => s.id));
    const sameSet =
      orderedIds.length === existing.size &&
      new Set(orderedIds).size === orderedIds.length &&
      orderedIds.every((id) => existing.has(id));
    if (!sameSet) {
      return reply
        .status(400)
        .send({ error: "Die Reihenfolge muss genau die Schritte dieser Aufgabe enthalten" });
    }

    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.step.update({ where: { id: orderedIds[i] }, data: { orderIndex: i } });
      }
      // "Wartet auf" komplett entfernen (auch Links, in denen diese Schritte
      // Vorgänger sind) – nach dem Umsortieren wartet niemand mehr auf jemanden.
      await tx.stepPredecessor.deleteMany({
        where: { OR: [{ stepId: { in: orderedIds } }, { predecessorId: { in: orderedIds } }] },
      });
    });

    publish("lagerhub", { type: "STEPS_REORDERED", taskId });
    return reply.status(204).send();
  });

  app.patch("/:id", { preHandler: [authDashboard] }, async (req) => {
    const { id } = req.params as { id: string };
    const body = UpdateStepSchema.parse(req.body);

    const step = await prisma.$transaction(async (tx) => {
      if (body.predecessorIds !== undefined) {
        await tx.stepPredecessor.deleteMany({ where: { stepId: id } });
        await tx.stepPredecessor.createMany({
          data: body.predecessorIds.map((predecessorId) => ({ stepId: id, predecessorId })),
        });
      }

      return tx.step.update({
        where: { id },
        data: {
          ...(body.description !== undefined && { description: body.description }),
          ...(body.minWorkers !== undefined && { minWorkers: body.minWorkers }),
          ...(body.maxWorkers !== undefined && { maxWorkers: body.maxWorkers }),
          ...(body.noteRequired !== undefined && { noteRequired: body.noteRequired }),
          ...(body.noteFormat !== undefined && { noteFormat: body.noteFormat }),
          ...(body.noteLabel !== undefined && { noteLabel: body.noteLabel }),
        },
        include: { skill: true, predecessors: { include: { predecessor: true } } },
      });
    });

    publish("lagerhub", { type: "STEP_UPDATED", step });
    return step;
  });

  // Notiz-Eintrag an den Schritt-Verlauf anhängen (append-only). Manager (Dashboard)
  // Notiz anhängen: Manager (Dashboard) UND MA (PWA) → authAny. Autor kommt aus
  // dem Token, NICHT aus dem Body: ein WORKER schreibt einen MA-Eintrag unter
  // seinem Namen (req.user), Dashboard-Rollen ebenso unter ihrem Namen (mit
  // Rolle Manager/Büro/Admin). So kann niemand im Namen eines anderen posten.
  app.post("/:id/notes", { preHandler: [authAny] }, async (req) => {
    const { id } = req.params as { id: string };
    const { text } = AddNoteSchema.parse(req.body);

    const { authorType, authorName } = noteAuthorFromUser(req.user);

    const step = await prisma.$transaction(async (tx) => {
      const current = await tx.step.findUniqueOrThrow({ where: { id }, select: { notes: true } });
      const notes = asNoteArray(current.notes);
      notes.push(makeNoteEntry(text, authorType, authorName));
      return tx.step.update({
        where: { id },
        data: { notes: notes as unknown as Prisma.InputJsonValue },
        include: { skill: true, predecessors: { include: { predecessor: true } } },
      });
    });

    publish("lagerhub", { type: "STEP_NOTE_UPDATED", stepId: id, taskId: step.taskId });
    return step;
  });

  app.delete("/:id", { preHandler: [authDashboard] }, async (req, reply) => {
    const { id } = req.params as { id: string };

    // Nachfolger-Vorgänger-Links bereinigen
    await prisma.$transaction([
      prisma.stepPredecessor.deleteMany({ where: { OR: [{ stepId: id }, { predecessorId: id }] } }),
      prisma.step.delete({ where: { id } }),
    ]);

    publish("lagerhub", { type: "STEP_DELETED", stepId: id });
    return reply.status(204).send();
  });
};
