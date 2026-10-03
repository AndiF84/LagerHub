import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { authAny } from "../auth.js";

const SubscribeSchema = z.object({
  subscription: z
    .object({
      endpoint: z.string().url(),
      keys: z.object({ p256dh: z.string(), auth: z.string() }),
    })
    .passthrough(),
});

export const pushRoutes: FastifyPluginAsync = async (app) => {
  // VAPID Public Key für den Client (PWA braucht ihn zum Abonnieren)
  app.get("/vapid-public-key", async () => {
    return { publicKey: process.env.VAPID_PUBLIC_KEY ?? null };
  });

  // Web-Push-Abo eines Geräts speichern (endpoint ist eindeutig → upsert).
  // employeeId kommt aus dem Token – das Abo gehört dem angemeldeten Gerät.
  app.post("/subscribe", { preHandler: [authAny] }, async (req, reply) => {
    const { subscription } = SubscribeSchema.parse(req.body);
    const employeeId = req.user.sub;
    const sub = await prisma.pushSubscription.upsert({
      where: { endpoint: subscription.endpoint },
      create: {
        employeeId,
        endpoint: subscription.endpoint,
        subscription: subscription as Prisma.InputJsonValue,
      },
      update: { employeeId, subscription: subscription as Prisma.InputJsonValue },
    });
    return reply.status(201).send({ id: sub.id });
  });

  // Abmelden (z. B. beim Logout). Nur das EIGENE Abo darf entfernt werden
  // (employeeId aus dem Token) – sonst könnte ein beliebiges Token per fremdem
  // endpoint die Push-Abos anderer MA löschen.
  app.post("/unsubscribe", { preHandler: [authAny] }, async (req) => {
    const { endpoint } = z.object({ endpoint: z.string().url() }).parse(req.body);
    await prisma.pushSubscription.deleteMany({
      where: { endpoint, employeeId: req.user.sub },
    });
    return { ok: true };
  });
};
