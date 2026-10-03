// ---------------------------------------------------------------------------
// Anwesenheits-Sync aus der Crewmeister-Zeiterfassung.
//
// Für jeden Mitarbeiter im Auto-Modus (presenceOverride == null) mit gesetzter
// crewmeisterUserId wird `present` aus dem Live-Stempelstatus gesetzt:
// eingestempelt → present=true, ausgestempelt → present=false. Manuell gepinnte
// MA (presenceOverride != null) und MA ohne Zuordnung bleiben unberührt.
//
// An den WECHSEL ist die Arbeitszeit-Erfassung gekoppelt:
//   ausstempeln → alle laufenden Zuweisungen werden unterbrochen (die Uhr stoppt)
//   einstempeln → Erinnerung an die eigenen unterbrochenen Schritte
// Ohne das erste lief ein Schritt über Nacht weiter und die ganze Nacht wurde als
// Arbeitszeit gebucht (Netto = finishedAt − startedAt − pausedMs).
//
// "Best effort": fehlt die Konfiguration oder ist Crewmeister nicht erreichbar,
// passiert nichts (kein Crash) – die zuletzt bekannten Werte bleiben bestehen.
// Für MA OHNE Zeiterfassung bleibt die uhrzeitbasierte Regel im Scheduler das
// Auffangnetz (Feierabend zu `workEnd`, Erinnerung zu `workStart`).
// ---------------------------------------------------------------------------
import { prisma } from "../db.js";
import { publish } from "../events.js";
import { afterAssignmentChange, remindOwnInterruptedSteps } from "../routes/assignments.js";
import { crewmeisterConfigured, getPresentUserIds, CrewmeisterError } from "./crewmeister.js";

export async function syncCrewmeisterPresence(): Promise<{ changed: number } | null> {
  if (!crewmeisterConfigured()) return null;

  let presentIds: Set<number>;
  try {
    presentIds = await getPresentUserIds();
  } catch (err) {
    const msg = err instanceof CrewmeisterError ? err.message : String(err);
    console.warn(`[presence] Crewmeister-Abruf übersprungen: ${msg}`);
    return null;
  }

  const autoEmployees = await prisma.employee.findMany({
    where: { deletedAt: null, presenceOverride: null, crewmeisterUserId: { not: null } },
    select: { id: true, present: true, crewmeisterUserId: true },
  });

  let changed = 0;
  for (const e of autoEmployees) {
    const desired = presentIds.has(e.crewmeisterUserId!);
    if (desired === e.present) continue;
    await prisma.employee.update({ where: { id: e.id }, data: { present: desired } });
    // Reines Invalidierungs-Signal an die Clients (Dashboard/Mitarbeiterliste).
    publish("lagerhub", { type: "EMPLOYEE_UPDATED", employeeId: e.id });
    changed++;

    // Der eigentliche Zweck des Wechsels – ein Fehler hier (z. B. beim Push)
    // darf den Sync der übrigen MA nicht abbrechen.
    try {
      await handlePresenceTransition(e.id, desired);
    } catch (err) {
      console.error(`[presence] Nachlauf für ${e.id} fehlgeschlagen:`, (err as Error).message);
    }
  }
  return { changed };
}

/**
 * Folge eines Anwesenheits-WECHSELS – unabhängig davon, wer ihn ausgelöst hat:
 * der Stempel aus Crewmeister (oben) ODER die manuelle Anwesenheit im Dashboard
 * (`PATCH /employees/:id`, siehe routes/employees.ts).
 *
 * Beide Wege müssen dasselbe tun, sonst wäre die manuelle Anwesenheit ein
 * Schlupfloch: „Mitarbeiter auf abwesend stellen" hätte seine laufende Arbeit
 * weiterlaufen lassen und die Zeit weitergezählt.
 *
 * NUR bei echtem Wechsel aufrufen (vorher != nachher) – sonst würde jedes
 * Speichern am Mitarbeiter eine Erinnerung auslösen.
 */
export async function handlePresenceTransition(
  employeeId: string,
  nowPresent: boolean,
): Promise<void> {
  if (nowPresent) {
    // Kommt (zurück) an die Arbeit → woran er noch dran war.
    await remindOwnInterruptedSteps(employeeId);
  } else {
    await pauseWorkOnClockOut(employeeId);
  }
}

/**
 * Geht: alle laufenden (ACTIVE) Zuweisungen des MA unterbrechen.
 *
 * `pausedAt = jetzt` stoppt die Uhr – beim Fortsetzen rechnet `closePause` das
 * Intervall auf `pausedMs`, die Netto-Arbeitszeit bleibt also sauber.
 * `pausedReason: END_OF_DAY` und NICHT `SWITCH`: das ist kein Arbeitsschritt-
 * Wechsel, `switchCount` (Auswertung „wie oft gewechselt") bleibt unberührt.
 *
 * Genauigkeit: der Sync läuft im Minutentakt, die Unterbrechung setzt also bis
 * zu 60 s nach dem echten Stempel ein. Die exakte Stempelzeit rückwirkend zu
 * übernehmen bräuchte einen weiteren Crewmeister-Abruf (Stempel-Zeitpunkt statt
 * nur „offen/geschlossen") – bewusst nicht gemacht.
 */
async function pauseWorkOnClockOut(employeeId: string): Promise<void> {
  const active = await prisma.assignment.findMany({
    where: { employeeId, state: "ACTIVE" },
    select: { id: true, stepId: true, step: { select: { taskId: true } } },
  });
  if (active.length === 0) return;

  await prisma.assignment.updateMany({
    where: { id: { in: active.map((a) => a.id) } },
    data: { state: "PAUSED", pausedReason: "END_OF_DAY", pausedAt: new Date() },
  });

  // Abgeleiteten Schritt-/Aufgaben-Status nachziehen und die Clients informieren
  // (ASSIGNMENT_CHANGED; bei Team-Schritten ggf. TEAM_UNDERSTAFFED).
  for (const a of active) {
    await afterAssignmentChange(a.stepId, a.step.taskId);
  }
  console.log(`[presence] ${active.length} Zuweisung(en) nach Ausstempeln unterbrochen`);
}
