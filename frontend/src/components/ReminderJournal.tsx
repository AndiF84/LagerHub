// Erinnerungs-Entscheidungen im Tagesjournal – gemeinsam genutzt vom Dashboard
// (heute) und vom Historie-Tab (ein bestimmter Tag), damit beide gleich
// aussehen. Gegenstück zu JournalRunCard, das die Arbeits-Durchläufe zeigt.
//
// Bewusst eine schlanke Zeile statt einer aufklappbaren Karte: Hier gibt es
// nichts aufzuklappen – Titel, Entscheidung, Name und Uhrzeit sind alles.
import { useJournalReminders } from "../api/queries";
import { DECISION_ICON, DECISION_LABEL, formatDay, formatTime } from "../lib/reminderFormat";

export function ReminderJournal({ date }: { date?: string }) {
  const { data: events } = useJournalReminders(date);

  if (!events || events.length === 0) return null;

  return (
    <div className="reminder-journal">
      <h3 className="reminder-journal__head">Erinnerungen</h3>
      {events.map((e) => (
        <div key={e.id} className="reminder-journal__row">
          <span className={`reminder-decision reminder-decision--${e.decision}`}>
            {DECISION_ICON[e.decision]} {DECISION_LABEL[e.decision]}
          </span>
          <span className="reminder-journal__title">{e.reminderTitle}</span>
          <span className="reminder-journal__who">
            {e.decidedByName} · {formatTime(e.decidedAt)}
            {/* Beim Verschieben ist das Ziel die eigentliche Information –
                sonst steht im Journal nur "verschoben" ohne Wohin. */}
            {e.decision === "POSTPONED" && e.postponedTo && ` → ${formatDay(e.postponedTo)}`}
          </span>
        </div>
      ))}
    </div>
  );
}
