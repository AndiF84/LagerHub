import { prisma } from "../db.js";
import { publish } from "../events.js";

// Automatische Aufbewahrung der Tagesjournale: entfernt TaskRuns, die älter als
// die in den Settings hinterlegte Anzahl Tage sind. WorkLogs hängen per
// onDelete: Cascade an TaskRun und verschwinden automatisch mit.
//
// Tag-Grenze in Server-Lokalzeit (wie der "heute"-Filter): cutoff = lokale
// Mitternacht von heute minus N Tagen. Ein Lauf mit finishedAt < cutoff gilt als
// "älter als N Tage". Beispiel N=30: ein heute fertiger Lauf bleibt 30 Tage.
//
// journalRetentionDays = 0 → deaktiviert (es wird nichts gelöscht).
export async function purgeOldJournals(): Promise<{ deleted: number; days: number }> {
  const settings = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const days = settings?.journalRetentionDays ?? 0;
  if (!days || days <= 0) return { deleted: 0, days: 0 };

  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - days);

  // Die Erinnerungs-Entscheidungen desselben Zeitraums gehen mit: sie sind Teil
  // des Tagesjournals, hängen aber an keinem TaskRun und würden sonst als
  // Rest ohne zugehörigen Tag zurückbleiben.
  const [runs, events] = await prisma.$transaction([
    prisma.taskRun.deleteMany({ where: { finishedAt: { lt: cutoff } } }),
    prisma.reminderEvent.deleteMany({ where: { decidedAt: { lt: cutoff } } }),
  ]);
  const count = runs.count + events.count;

  // Ein Sammel-Event genügt – das Frontend invalidiert darüber die komplette
  // Historie (Prefix ["stats"]).
  if (count > 0) publish("lagerhub", { type: "JOURNAL_DELETED", reason: "retention", days });

  return { deleted: count, days };
}
