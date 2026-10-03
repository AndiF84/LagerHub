import webpush from "web-push";
import type { PushSubscription as WebPushSubscription } from "web-push";
import { prisma } from "../db.js";
import { deriveStepStatus, stepStatusSelect } from "./stepStatus.js";

// ---------------------------------------------------------------------------
// Web Push (VAPID). Push ist "best effort": fehlende Keys oder Sendefehler
// dürfen NIE einen Request-Pfad zum Scheitern bringen.
// ---------------------------------------------------------------------------
const publicKey = process.env.VAPID_PUBLIC_KEY;
const privateKey = process.env.VAPID_PRIVATE_KEY;
const subject = process.env.VAPID_SUBJECT ?? "mailto:admin@example.com";

let configured = false;
if (publicKey && privateKey) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
} else {
  console.warn("[push] VAPID-Keys fehlen – Web Push ist deaktiviert");
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// Sendet eine Push-Nachricht an alle Geräte-Abos der angegebenen Mitarbeiter.
export async function sendPushToEmployees(employeeIds: string[], payload: PushPayload): Promise<void> {
  if (!configured || employeeIds.length === 0) return;
  try {
    const subs = await prisma.pushSubscription.findMany({
      where: { employeeId: { in: employeeIds } },
    });
    const body = JSON.stringify(payload);

    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(s.subscription as unknown as WebPushSubscription, body);
        } catch (err) {
          const statusCode = (err as { statusCode?: number }).statusCode;
          // 404/410 → Abo abgelaufen/abgemeldet → aufräumen
          if (statusCode === 404 || statusCode === 410) {
            await prisma.pushSubscription.delete({ where: { id: s.id } }).catch(() => {});
          } else {
            console.error("[push] Sendefehler:", statusCode ?? (err as Error).message);
          }
        }
      })
    );
  } catch (err) {
    console.error("[push] unerwarteter Fehler:", (err as Error).message);
  }
}

// Ermittelt freie, qualifizierte MA für einen Schritt und pusht ihn.
// Frei = kein aktives Assignment; qualifiziert = passende Fähigkeit.
export async function notifyReleasedStep(stepId: string): Promise<void> {
  if (!configured) return;
  try {
    const step = await prisma.step.findUnique({
      where: { id: stepId },
      include: { task: true },
    });
    if (!step) return;

    // Empfänger: qualifiziert und NICHT bereits auf einer HIGH-Aufgabe aktiv. So
    // werden auch MA benachrichtigt, die gerade an einem Schritt NIEDRIGERER
    // Priorität arbeiten (damit sie zur wichtigen Aufgabe umschwenken können); wer
    // schon auf einer hochprioren Aufgabe eingeloggt ist, wird nicht gestört.
    const free = await prisma.employee.findMany({
      where: {
        deletedAt: null,
        skills: { some: { skillId: step.skillId } },
        assignments: { none: { state: "ACTIVE", step: { task: { priority: "HIGH" } } } },
      },
      select: { id: true },
    });

    await sendPushToEmployees(
      free.map((e) => e.id),
      {
        title: `Aufgabe „${step.task.name}" (hoch)`,
        body: `Schritt „${step.name}" ist verfügbar`,
        data: { taskId: step.taskId, stepId: step.id },
      }
    );
  } catch (err) {
    console.error("[push] notifyReleasedStep:", (err as Error).message);
  }
}

// Manuelles Angebot des Managers: einen bestimmten MA über die ihm angebotene
// Arbeit benachrichtigen (best effort).
export async function notifyAssignmentOffer(assignmentId: string): Promise<void> {
  if (!configured) return;
  try {
    const a = await prisma.assignment.findUnique({
      where: { id: assignmentId },
      include: { step: { include: { task: true } } },
    });
    if (!a) return;

    await sendPushToEmployees([a.employeeId], {
      title: `Neue Aufgabe: „${a.step.task.name}"`,
      body: `Du wurdest für Schritt „${a.step.name}" eingeteilt – annehmen oder ablehnen?`,
      data: { type: "ASSIGNMENT_OFFER", assignmentId: a.id, stepId: a.stepId, taskId: a.step.taskId },
    });
  } catch (err) {
    console.error("[push] notifyAssignmentOffer:", (err as Error).message);
  }
}

// Regel 1: Aufgabe auf "hoch" gestuft → Push für alle freigegebenen (offenen) Schritte.
export async function notifyHighPriorityTask(taskId: string): Promise<void> {
  if (!configured) return;
  try {
    // Status aller Schritte in EINER Abfrage holen und rein ableiten (kein N+1).
    const steps = await prisma.step.findMany({
      where: { taskId },
      select: { id: true, ...stepStatusSelect },
    });
    for (const s of steps) {
      if (deriveStepStatus(s) === "OPEN") {
        await notifyReleasedStep(s.id);
      }
    }
  } catch (err) {
    console.error("[push] notifyHighPriorityTask:", (err as Error).message);
  }
}
