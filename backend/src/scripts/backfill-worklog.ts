// Einmaliger, idempotenter Backfill der WorkLog-Tabelle aus den vorhandenen
// TaskRun-Snapshots. Leert WorkLog und baut es neu auf – beliebig oft
// wiederholbar. Aufruf: `npm run backfill:worklog` (oder `tsx src/scripts/...`).
//
// Hinweis: Läufe von vor der pausedMs-Migration haben pausedMs=0, ihre
// Netto-Zeit (activeMs) entspricht dort also der Bruttozeit (bekannte Grenze).
import { prisma } from "../db.js";

type SnapAssignment = {
  employeeId?: string;
  startedAt?: string;
  finishedAt?: string | null;
  pausedMs?: number;
};
type SnapStep = { name?: string; assignments?: SnapAssignment[] };
type Snap = { steps?: SnapStep[] };

async function main() {
  const runs = await prisma.taskRun.findMany();
  console.log(`Backfill WorkLog: ${runs.length} TaskRuns gefunden.`);

  const del = await prisma.workLog.deleteMany({});
  console.log(`  ${del.count} bestehende WorkLog-Zeilen entfernt.`);

  // Nur Zuweisungen auf noch existierende Employees (FK). Soft-gelöschte MA
  // haben weiterhin eine Zeile → ihre Historie zählt; hart entfernte nicht.
  const empIds = new Set(
    (await prisma.employee.findMany({ select: { id: true } })).map((e) => e.id),
  );

  let created = 0;
  let skipped = 0;
  for (const run of runs) {
    const snap = (run.data as Snap) ?? {};
    const rows = [];
    for (const s of snap.steps ?? []) {
      for (const a of s.assignments ?? []) {
        if (!a.employeeId || !empIds.has(a.employeeId) || !a.startedAt) {
          skipped++;
          continue;
        }
        const startedAt = new Date(a.startedAt);
        const finishedAt = a.finishedAt ? new Date(a.finishedAt) : run.finishedAt;
        const pausedMs = a.pausedMs ?? 0;
        rows.push({
          runId: run.id,
          employeeId: a.employeeId,
          taskName: run.taskName,
          stepName: s.name ?? "",
          startedAt,
          finishedAt,
          activeMs: Math.max(0, finishedAt.getTime() - startedAt.getTime() - pausedMs),
          pausedMs,
        });
      }
    }
    if (rows.length) {
      await prisma.workLog.createMany({ data: rows });
      created += rows.length;
    }
  }

  console.log(`Fertig: ${created} WorkLog-Zeilen erstellt, ${skipped} übersprungen.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
