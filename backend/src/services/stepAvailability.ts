// Pflege von `Step.availableAt` – dem Zeitpunkt, ab dem ein Schritt ABHOLBAR ist
// (Status OPEN: alle Vorgänger erledigt UND die Aufgabe im Pool).
//
// Warum eine eigene Spalte statt einer Ableitung: der Moment der Freigabe hängt
// an zwei Ereignissen (Pool-Eintritt, Abschluss des letzten Vorgängers) und
// hinterlässt sonst keine Spur. Der frühere Behelf im Scheduler (letzter
// `Assignment.finishedAt` am Schritt, sonst `task.startedAt`) rechnete für spät
// freigeschaltete Schritte ab Aufgaben-Start – ein Schritt, der nach zwei
// Stunden Vorgängerarbeit frei wurde, galt sofort als zwei Stunden überfällig.
//
// Regel: nur SETZEN, nie überschreiben. Ein bereits gestempelter Schritt behält
// seinen Zeitpunkt (auch wenn er inzwischen bearbeitet wird – dann ist es die
// historische Angabe „war abholbar seit"). Zurückgesetzt wird ausschließlich
// beim Lauf-Ende bzw. beim Verlassen des Pools (siehe clearAvailability).
import type { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { deriveStepStatus, stepStatusSelect } from "./stepStatus.js";

type Client = Prisma.TransactionClient | typeof prisma;

/**
 * Stempelt alle aktuell OFFENEN Schritte der Aufgabe, die noch keinen Zeitpunkt
 * haben. Aufzurufen, wenn eine Aufgabe in den Pool kommt (Starten/Restart) –
 * dann sind das die Schritte ohne Vorgänger bzw. die bereits freigeschalteten.
 *
 * Idempotent: mehrfaches Aufrufen ändert bestehende Zeitpunkte nicht.
 */
export async function markAvailableSteps(taskId: string, client: Client = prisma) {
  const steps = await client.step.findMany({
    where: { taskId },
    select: { id: true, availableAt: true, ...stepStatusSelect },
  });

  const ids = steps
    .filter((s) => s.availableAt === null && deriveStepStatus(s) === "OPEN")
    .map((s) => s.id);
  if (ids.length === 0) return 0;

  await client.step.updateMany({
    where: { id: { in: ids } },
    data: { availableAt: new Date() },
  });
  return ids.length;
}

/**
 * Setzt EINEN Schritt auf „ab jetzt abholbar" – für den Moment, in dem der
 * letzte Vorgänger fertig wird (handleStepUnlocks). Der `availableAt: null`-Guard
 * macht den Aufruf idempotent: wird derselbe Abschluss-Pfad erneut durchlaufen,
 * bleibt der erste (richtige) Zeitpunkt stehen.
 */
export async function markStepAvailable(stepId: string, client: Client = prisma) {
  await client.step.updateMany({
    where: { id: stepId, availableAt: null },
    data: { availableAt: new Date() },
  });
}

/**
 * Räumt die Zeitpunkte einer Aufgabe ab – beim Lauf-Ende (finalizeTask/restart)
 * und beim Herausnehmen aus dem Pool. Ohne das behielte ein Schritt seinen alten
 * Zeitpunkt und erschiene beim nächsten Lauf sofort mit einem überhöhten Alter.
 */
export async function clearAvailability(taskId: string, client: Client = prisma) {
  await client.step.updateMany({ where: { taskId }, data: { availableAt: null } });
}
