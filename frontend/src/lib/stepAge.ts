// Wie lange wartet bzw. läuft ein Arbeitsschritt schon? – gemeinsame Regeln für
// die Anzeige in Dashboard und PWA (beide Apps halten bewusst eigene Kopien,
// siehe pwa/src/lib/stepAge.ts – identische Logik, getrennte Abhängigkeiten).
//
// Grundsatz: NICHT Datum/Uhrzeit anzeigen ("verfügbar seit 09:14"), sondern das
// Alter ("42 min"). Die Uhrzeit zwingt jeden zum Kopfrechnen; gefragt ist aber
// genau die Differenz. Der exakte Zeitpunkt steht im title-Tooltip.

import type { StepStatus } from "../api/types";

/**
 * Dringlichkeit des Alters – abgeleitet aus `Settings.escalationMins`.
 *
 * Bewusst an den BESTEHENDEN Schwellwert gekoppelt statt an eine eigene Zahl:
 * derselbe Wert löst den Eskalations-Push aus (services/scheduler.ts). Sonst
 * gäbe es zwei verschiedene Vorstellungen davon, was „zu lange" heißt, und die
 * Oberfläche könnte grau zeigen, während der Push „überfällig" meldet.
 */
export type AgeLevel = "calm" | "warn" | "over";

export function ageLevel(minutes: number, escalationMins: number | undefined): AgeLevel {
  // Ohne gültigen Schwellwert bleibt es eine reine Information (keine Ampel).
  if (!escalationMins || escalationMins <= 0) return "calm";
  if (minutes >= escalationMins) return "over";
  if (minutes >= escalationMins / 2) return "warn";
  return "calm";
}

/**
 * Woran hängt die Uhr eines Schritts?
 *   OPEN/WAITING → `availableAt`: er ist abholbar und wird nicht abgeholt – das
 *                  ist die Liegenbleiber-Frage, hier greift die Ampel.
 *   ACTIVE/PAUSED → `startedAt`: der Schritt läuft, interessant ist die
 *                  bisherige Laufzeit. Keine Ampel – laufende Arbeit ist kein
 *                  Liegenbleiber, und `escalationMins` meint ausdrücklich
 *                  UNBEARBEITETE Schritte.
 *   DONE/LOCKED  → keine Anzeige.
 */
export type StepAgeBasis = { since: string; label: string; escalate: boolean } | null;

export function stepAgeBasis(step: {
  computedStatus?: StepStatus;
  availableAt: string | null;
  startedAt: string | null;
}): StepAgeBasis {
  switch (step.computedStatus) {
    case "OPEN":
    case "WAITING":
      return step.availableAt ? { since: step.availableAt, label: "wartet seit", escalate: true } : null;
    case "ACTIVE":
    case "PAUSED":
      return step.startedAt ? { since: step.startedAt, label: "läuft seit", escalate: false } : null;
    default:
      return null;
  }
}

/** Verstrichene volle Minuten seit `iso` (nie negativ – Uhren laufen auseinander). */
export function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000));
}

/**
 * Alter als Text: "42 min", "3 h 05 min", "9 d 2 h".
 *
 * Bewusst NICHT `formatMinutes` aus lib/formatDuration: das kennt nur Stunden
 * und liefert für einen liegengebliebenen Schritt "216 h 40 min" – eine Zahl,
 * die niemand als „neun Tage" liest. Und es NICHT dort zu ändern ist Absicht:
 * `formatMinutes` bedient Statistik und Excel-Export, wo Stunden die Einheit
 * sind (siehe Kommentar dort).
 *
 * Ab einem Tag entfallen die Minuten – auf dieser Skala sind sie Rauschen.
 */
export function formatAge(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));
  if (total < 60) return `${total} min`;

  const hours = Math.floor(total / 60);
  if (hours < 24) {
    const m = total % 60;
    return m === 0 ? `${hours} h` : `${hours} h ${String(m).padStart(2, "0")} min`;
  }

  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h === 0 ? `${days} d` : `${days} d ${h} h`;
}

/** Exakter Zeitpunkt für den Tooltip: "08.08.2026, 09:14 Uhr". */
export function formatTimestamp(iso: string): string {
  return `${new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })} Uhr`;
}
