// Terminrechnung für Erinnerungen. Bewusst OHNE Datenbank und ohne Uhrzeiten:
// Erinnerungen sind TAGESGENAU. Fällig ist, was heute oder früher dran ist – das
// Dashboard zeigt das beim Laden als Banner. Deshalb braucht es hier keinen
// Scheduler-Tick und kein Nachholen verpasster Minuten: eine überfällige
// Erinnerung steht einfach weiter im Banner, bis jemand entscheidet.
import type { RepeatRule } from "@prisma/client";

// Lokale Mitternacht – dieselbe Tagesgrenze wie `localDayKey` in stats.ts und
// der Stichtag der Journal-Aufbewahrung.
export function startOfLocalDay(d: Date = new Date()): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

export function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

export interface RepeatSpec {
  repeatRule: RepeatRule;
  intervalDays: number | null;
  weekday: number | null;
  dayOfMonth: number | null;
}

/**
 * Nächster Fälligkeitstag NACH `from` (Default: heute).
 *
 * Bezugspunkt ist bewusst der Tag der ENTSCHEIDUNG, nicht der alte
 * Fälligkeitstag: Wer eine tägliche Erinnerung eine Woche lang liegen lässt und
 * dann abhakt, soll sie morgen wiedersehen – nicht sechsmal rückwirkend. Der
 * Takt setzt damit ab dem Moment neu auf, in dem tatsächlich etwas geschehen ist.
 *
 * `null` = kein weiterer Termin (einmalige Erinnerung ist damit abgeschlossen).
 */
export function computeNextDue(spec: RepeatSpec, from: Date = new Date()): Date | null {
  const base = startOfLocalDay(from);

  switch (spec.repeatRule) {
    case "NONE":
      return null;

    case "DAILY":
      return addDays(base, 1);

    case "INTERVAL": {
      // Ohne sinnvollen Wert lieber morgen als gar nicht: eine Erinnerung, die
      // still verschwindet, ist der teurere Fehler.
      const n = spec.intervalDays && spec.intervalDays > 0 ? spec.intervalDays : 1;
      return addDays(base, n);
    }

    case "WEEKLY": {
      // 0 = Sonntag … 6 = Samstag (wie Date.getDay). Immer der NÄCHSTE solche
      // Tag: fällt der Wochentag auf heute, ist erst nächste Woche wieder dran.
      const target = spec.weekday ?? base.getDay();
      const diff = (target - base.getDay() + 7) % 7;
      return addDays(base, diff === 0 ? 7 : diff);
    }

    case "MONTHLY": {
      // Auf den Monatsletzten kappen: "am 31." im Februar ist der 28./29., statt
      // (wie es die JS-Date-Arithmetik täte) in den März zu rutschen.
      const wunsch = spec.dayOfMonth ?? base.getDate();
      const jahr = base.getFullYear();
      const monat = base.getMonth();
      const kandidat = new Date(jahr, monat, 1);
      kandidat.setMonth(monat + 1); // immer der Folgemonat – nie derselbe Tag nochmal
      const letzterTag = new Date(kandidat.getFullYear(), kandidat.getMonth() + 1, 0).getDate();
      kandidat.setDate(Math.min(wunsch, letzterTag));
      return startOfLocalDay(kandidat);
    }

    default:
      return null;
  }
}

// Verschieben: 1–7 Tage ab heute. Die Obergrenze ist Absicht – wer länger
// schieben will, soll den Termin in der Erinnerung selbst ändern, statt sie
// Woche für Woche vor sich herzuschieben.
export const MAX_POSTPONE_DAYS = 7;

export function postponeDate(days: number, from: Date = new Date()): Date {
  const n = Math.min(Math.max(Math.round(days), 1), MAX_POSTPONE_DAYS);
  return addDays(startOfLocalDay(from), n);
}
