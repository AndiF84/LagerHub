/**
 * Ruhezeit (Pause), in der keine Eskalations-Benachrichtigung rausgeht.
 *
 * Die Zeiten stehen in `Settings` (`breakStart`/`breakEnd`) und sind im
 * Einstellungen-Tab pflegbar (nur ADMIN). Früher waren sie hart hier im Code –
 * das ist bewusst aufgegeben worden: Pausenzeiten ändern sich im Betrieb
 * (Sommer-/Winterrhythmus, Schichtwechsel) und ein Code-Deploy ist dafür der
 * falsche Weg.
 *
 * Die Funktion bleibt **pur**: sie liest nichts aus der DB, sondern bekommt die
 * Werte übergeben. Der Scheduler hat die Settings zu Beginn seines Ticks ohnehin
 * geladen – es kostet also keine zusätzliche Abfrage, und die Grenzfälle bleiben
 * ohne Prisma-Mock testbar.
 */
export interface QuietPeriod {
  /** "HH:mm" – Beginn, einschließlich */
  breakStart: string;
  /** "HH:mm" – Ende, ausschließlich */
  breakEnd: string;
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? "");
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Liegt der Zeitpunkt in der Pause?
 *
 * Konvention wie bei den Arbeitszeiten im Scheduler: Beginn **einschließlich**,
 * Ende **ausschließlich**. Bei 12:00–12:30 schweigt der Alarm ab 12:00 und feuert
 * um 12:30 wieder – sofern der Schritt dann noch unbesetzt und überfällig ist.
 *
 * Sonderfälle, die alle „keine Pause" bedeuten (der Alarm läuft also durch):
 *  - `breakStart === breakEnd` → Pause deaktiviert (analog `journalRetentionDays = 0`)
 *  - `breakEnd < breakStart` → über Mitternacht; für eine Pause sinnlos und in der
 *    Route ohnehin abgewiesen. Hier trotzdem abgefangen, damit ein Altbestand in
 *    der DB nicht dazu führt, dass die Eskalation dauerhaft schweigt – lieber
 *    einmal zu viel melden als still verstummen.
 *  - unparsbare Werte → wie deaktiviert
 *
 * `now` ist injizierbar, damit die Grenzfälle testbar sind, ohne die Systemuhr zu
 * stellen; im Betrieb wird der Default (jetzt) genutzt.
 */
export function isWithinQuietPeriod(period: QuietPeriod, now: Date = new Date()): boolean {
  const start = toMinutes(period?.breakStart);
  const end = toMinutes(period?.breakEnd);
  if (start === null || end === null) return false;
  if (end <= start) return false;

  const current = now.getHours() * 60 + now.getMinutes();
  return current >= start && current < end;
}
