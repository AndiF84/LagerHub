// Räumt VERWAISTE Zuweisungen auf: Ein Mitarbeiter ist auf einem Schritt
// eingeloggt, dessen Aufgabe nicht (mehr) im Pool steht. Für ihn ist der Schritt
// unsichtbar (die Pool-Abfrage filtert auf poolEnabled) – er kann ihn weder
// abschließen noch verlassen und bleibt dauerhaft als „im Einsatz" gezählt.
//
// Ursache war der Pool-Austritt (PATCH /tasks/:id mit poolEnabled=false), der die
// Zuweisungen stehen ließ. Das ist in der Route behoben; dieses Skript beseitigt
// die Altlasten, die davor entstanden sind.
//
// Aufgeräumt wird NUR, wo keine Arbeitszeit im Spiel ist: Die Aufgabe darf nicht
// begonnen sein (task.startedAt === null) UND der Schritt-Timer darf nicht laufen
// (step.startedAt === null). Alles andere wird nur gemeldet, nie angefasst – dort
// hängt gebuchte Zeit dran, die kein Aufräumskript verwerfen darf.
//
// Aufruf:  npm run fix:orphans          (nur anzeigen, ändert nichts)
//          npm run fix:orphans -- --apply   (tatsächlich löschen)
import { prisma } from "../db.js";

async function main() {
  const apply = process.argv.includes("--apply");

  const orphans = await prisma.assignment.findMany({
    where: {
      state: { in: ["ACTIVE", "PAUSED", "OFFERED"] },
      step: { task: { poolEnabled: false, deletedAt: null } },
    },
    select: {
      id: true,
      state: true,
      employee: { select: { name: true } },
      step: {
        select: {
          startedAt: true,
          skill: { select: { name: true } },
          task: { select: { name: true, startedAt: true } },
        },
      },
    },
    orderBy: { startedAt: "asc" },
  });

  if (orphans.length === 0) {
    console.log("Keine verwaisten Zuweisungen gefunden – alles sauber.");
    return;
  }

  const loeschbar = orphans.filter(
    (a) => a.step.startedAt === null && a.step.task.startedAt === null,
  );
  const behalten = orphans.filter((a) => !loeschbar.includes(a));

  console.log(`${orphans.length} verwaiste Zuweisung(en) gefunden:\n`);
  for (const a of orphans) {
    const mark = loeschbar.includes(a) ? "  [aufräumen]" : "  [BEHALTEN ]";
    console.log(
      `${mark} ${a.employee.name} – "${a.step.task.name}" / Schritt "${a.step.skill.name}" (${a.state})`,
    );
  }

  if (behalten.length > 0) {
    console.log(
      `\n${behalten.length} Zuweisung(en) werden NICHT angefasst: dort lief bereits ein Timer,` +
        ` es hängt gebuchte Arbeitszeit daran. Diese Aufgaben bitte im Dashboard wieder` +
        ` starten und regulär abschließen.`,
    );
  }

  if (!apply) {
    console.log(
      `\nTestlauf – es wurde nichts geändert.` +
        ` Zum Ausführen: npm run fix:orphans -- --apply`,
    );
    return;
  }

  const del = await prisma.assignment.deleteMany({
    where: { id: { in: loeschbar.map((a) => a.id) } },
  });
  console.log(`\n${del.count} Zuweisung(en) entfernt. Die Mitarbeiter sind wieder frei.`);
  console.log("Hinweis: Dashboard/PWA einmal neu laden (das Skript sendet kein Live-Event).");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
