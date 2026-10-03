// Wie lange wartet bzw. läuft ein Arbeitsschritt schon? – Gegenstück zu
// frontend/src/lib/stepAge.ts. Beide Apps halten bewusst eigene Kopien (die PWA
// teilt keinen Code mit dem Dashboard); die REGELN müssen aber gleich bleiben,
// sonst benennen Manager und Mitarbeiter denselben Schritt unterschiedlich.
//
// Grundsatz: NICHT Datum/Uhrzeit anzeigen ("verfügbar seit 09:14"), sondern das
// Alter ("42 min") – gefragt ist die Differenz, nicht der Zeitpunkt. Der exakte
// Zeitpunkt steht im title-Tooltip.

import type { StepStatus } from "../api/types";

/**
 * Dringlichkeit des Alters – abgeleitet aus `Settings.escalationMins`, also dem
 * BESTEHENDEN Schwellwert, auf den auch der Eskalations-Push feuert. Ein eigener
 * Wert hier würde bedeuten, dass die App etwas anderes „zu lange" nennt als das
 * Backend.
 */
export type AgeLevel = "calm" | "warn" | "over";

export function ageLevel(minutes: number, escalationMins: number | undefined): AgeLevel {
  if (!escalationMins || escalationMins <= 0) return "calm";
  if (minutes >= escalationMins) return "over";
  if (minutes >= escalationMins / 2) return "warn";
  return "calm";
}

/**
 * Woran hängt die Uhr eines Schritts?
 *   OPEN/WAITING  → `availableAt` ("wartet seit"), mit Ampel
 *   ACTIVE/PAUSED → `startedAt` ("läuft seit"), ohne Ampel (laufende Arbeit ist
 *                   kein Liegenbleiber; escalationMins meint unbearbeitete Schritte)
 *   sonst         → keine Anzeige
 */
export type StepAgeBasis = { since: string; label: string; escalate: boolean } | null;

export function stepAgeBasis(step: {
  computedStatus: StepStatus;
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
 * Ab einem Tag entfallen die Minuten – auf dieser Skala sind sie Rauschen, und
 * ein liegengebliebener Schritt liest sich als "9 d 2 h" deutlich schneller
 * als "218 h 40 min".
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
