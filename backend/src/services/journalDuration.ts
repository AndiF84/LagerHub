// Dauer eines Arbeitsschritts im Tagesjournal – aus den eingefrorenen
// Zuweisungs-Zeiten eines TaskRun-Snapshots.
//
// Gefragt ist die Zeit, die am Schritt gearbeitet wurde – NICHT die Summe der
// Personen-Zeit (drei MA à 20 min im Team sind 20 min Schritt, nicht 60) und
// NICHT die Wanduhr (eine Nacht Unterbrechung ist keine Schrittzeit).
//
// Das Snapshot kennt je Zuweisung nur Start, Ende und die KUMULIERTE
// Unterbrechung (pausedMs), nicht deren Lage. Annahme deshalb: der Arbeits-
// abschnitt ist [Start, Ende − Unterbrechung]. Das ist exakt für
//   - einen einzelnen MA (Länge = Netto-Zeit, egal wo die Pause lag),
//   - die Übernahme (A unterbricht, B übernimmt und schließt – A's Pause liegt
//     tatsächlich am Ende, bis zum gemeinsamen Abschluss),
//   - ein Team ohne Unterbrechung (gleiche Abschnitte, Vereinigung = einmal).
// Nur wenn im Team jemand MITTEN drin unterbricht, ist die Lage geschätzt.
// Überlappende Abschnitte werden vereinigt, die gemeinsame Zeit zählt einmal.
//
// stepStartedAt = Start des Team-Timers (Step.startedAt, seit dieser Version im
// Snapshot): Zeit, in der ein MA vor Erreichen der Mindestbesetzung nur
// gewartet hat, ist noch keine Schrittzeit. Ältere Snapshots haben das Feld
// nicht – dann zählt wie bisher ab dem Einloggen.

export interface DurationAssignment {
  startedAt?: string | Date | null;
  finishedAt?: string | Date | null;
  pausedMs?: number | null;
}

const toMs = (v: string | Date | null | undefined): number | null => {
  if (v == null) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
};

// Dauer in Millisekunden; null, wenn kein einziger auswertbarer Abschnitt da ist.
export function stepDurationMs(
  assignments: DurationAssignment[],
  stepStartedAt?: string | Date | null,
): number | null {
  const timerStart = toMs(stepStartedAt);
  const intervals: [number, number][] = [];
  for (const a of assignments) {
    const start = toMs(a.startedAt);
    const end = toMs(a.finishedAt);
    if (start == null || end == null) continue;
    const from = timerStart != null ? Math.max(start, timerStart) : start;
    const to = end - Math.max(0, a.pausedMs ?? 0);
    if (to > from) intervals.push([from, to]);
    else intervals.push([from, from]); // auswertbar, aber 0 – nicht „unbekannt"
  }
  if (intervals.length === 0) return null;

  intervals.sort((x, y) => x[0] - y[0]);
  let total = 0;
  let [curFrom, curTo] = intervals[0];
  for (const [from, to] of intervals.slice(1)) {
    if (from <= curTo) {
      curTo = Math.max(curTo, to);
    } else {
      total += curTo - curFrom;
      [curFrom, curTo] = [from, to];
    }
  }
  return total + (curTo - curFrom);
}

export function stepDurationMinutes(
  assignments: DurationAssignment[],
  stepStartedAt?: string | Date | null,
): number | null {
  const ms = stepDurationMs(assignments, stepStartedAt);
  return ms == null ? null : Math.round(ms / 60000);
}
