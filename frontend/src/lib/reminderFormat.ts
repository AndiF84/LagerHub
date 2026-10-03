// Anzeige-Hilfen für Erinnerungen. Erinnerungen sind TAGESGENAU – überall wird
// nur mit dem Datum gerechnet, nie mit einer Uhrzeit. Deshalb schneiden alle
// Funktionen hier auf den lokalen Tag zurück, statt Date-Objekte zu vergleichen
// (sonst wäre "heute 00:00" gegenüber "jetzt" bereits Vergangenheit).
import type { Reminder, ReminderDecision } from "../api/types";

// Obergrenze fuers Verschieben - muss zu MAX_POSTPONE_DAYS im Backend passen
// (services/reminders.ts); dort wird der Wert zusaetzlich erzwungen.
export const MAX_POSTPONE_DAYS = 7;

export const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

// "YYYY-MM-DD" des lokalen Tages – dieselbe Tagesgrenze wie im Backend.
export function todayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Ein ISO-Datum aus der API auf seinen Tagesschlüssel bringen.
function dayKeyOf(iso: string): string {
  return todayKey(new Date(iso));
}

export function isOverdue(dueIso: string, now: Date = new Date()): boolean {
  return dayKeyOf(dueIso) < todayKey(now);
}

/**
 * Fälligkeit in Worten. Nah am Heute wird relativ formuliert („heute",
 * „gestern", „seit 3 Tagen") – das ist die Frage, die im Betrieb zählt; das
 * genaue Datum steht bei allem, was weiter weg liegt.
 */
export function dueLabel(dueIso: string, now: Date = new Date()): string {
  const diff = dayDiff(todayKey(now), dayKeyOf(dueIso));
  if (diff === 0) return "heute";
  if (diff === -1) return "gestern";
  if (diff < -1) return `seit ${Math.abs(diff)} Tagen`;
  if (diff === 1) return "morgen";
  if (diff <= 7) return `in ${diff} Tagen`;
  return formatDay(dueIso);
}

export function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

// Ganze Tage zwischen zwei Tagesschlüsseln (b − a). Über die Mittagszeit
// gerechnet, damit die Sommerzeit-Umstellung (23- bzw. 25-Stunden-Tage) das
// Ergebnis nicht um einen Tag verschiebt.
function dayDiff(a: string, b: string): number {
  const da = new Date(`${a}T12:00:00`).getTime();
  const db = new Date(`${b}T12:00:00`).getTime();
  return Math.round((db - da) / 86_400_000);
}

export function describeRepeat(r: Reminder): string {
  switch (r.repeatRule) {
    case "NONE":
      return "einmalig";
    case "DAILY":
      return "täglich";
    case "WEEKLY":
      return `wöchentlich, ${WEEKDAYS[r.weekday ?? 1]}`;
    case "MONTHLY":
      return `monatlich, am ${r.dayOfMonth ?? 1}.`;
    case "INTERVAL":
      return `alle ${r.intervalDays ?? 1} Tage`;
    default:
      return "–";
  }
}

// Beschriftung der getroffenen Entscheidung – gleiche Wörter wie auf den
// Knöpfen im Banner, damit das Tagesjournal sich ohne Übersetzung liest.
export const DECISION_LABEL: Record<ReminderDecision, string> = {
  DONE: "Erledigt",
  POSTPONED: "Verschoben",
  POOLED: "In den Pool",
  OBSOLETE: "Hinfällig",
};

export const DECISION_ICON: Record<ReminderDecision, string> = {
  DONE: "✓",
  POSTPONED: "→",
  POOLED: "⇢",
  OBSOLETE: "✕",
};
