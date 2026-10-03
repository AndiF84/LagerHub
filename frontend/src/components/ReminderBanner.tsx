// Fällige Erinnerungen als Banner über dem Dashboard – das ist die Stelle, an
// der über sie entschieden wird. Vier Wege, alle mit derselben Folge: die
// Entscheidung wird namentlich mit Uhrzeit im Tagesjournal festgehalten.
//
//   Erledigt    – erledigt, nächster Termin nach Takt
//   Verschieben – 1 bis 7 Tage, der Takt bleibt unberührt
//   Pool        – wird zum Arbeitsschritt, den ein qualifizierter MA übernimmt
//   Hinfällig   – diesmal nicht nötig (die Erinnerung selbst bleibt bestehen)
//
// Nichts verschwindet von selbst: Überfälliges steht so lange hier, bis jemand
// eine Entscheidung trifft.
import { useState } from "react";
import { useDecideReminder, useDueReminders } from "../api/queries";
import type { Reminder, ReminderDecision } from "../api/types";
import { dueLabel, isOverdue, MAX_POSTPONE_DAYS } from "../lib/reminderFormat";

export function ReminderBanner() {
  const { data: faellig } = useDueReminders();

  if (!faellig || faellig.length === 0) return null;

  return (
    <div className="reminder-banner">
      {faellig.map((r) => (
        <ReminderCard key={r.id} reminder={r} />
      ))}
    </div>
  );
}

function ReminderCard({ reminder }: { reminder: Reminder }) {
  const decide = useDecideReminder();
  // Das Tage-Menü klappt erst beim Klick auf "Verschieben" auf – sieben Knöpfe
  // dauerhaft nebeneinander würden die Zeile überladen.
  const [zeigeTage, setZeigeTage] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const ueberfaellig = isOverdue(reminder.dueDate);
  const laeuft = decide.isPending;

  const entscheide = (decision: ReminderDecision, days?: number) => {
    setFehler(null);
    setZeigeTage(false);
    decide.mutate(
      { id: reminder.id, decision, days },
      { onError: (e) => setFehler(String(e)) },
    );
  };

  // "Pool" braucht eine Fähigkeit – ohne sie wäre niemand qualifiziert, den
  // Schritt zu übernehmen. Der Knopf bleibt sichtbar, aber gesperrt, damit
  // klar ist, was fehlt (der Grund steht im title).
  const poolMoeglich = reminder.skillId !== null;

  return (
    <div className={`reminder-card${ueberfaellig ? " reminder-card--overdue" : ""}`}>
      <div className="reminder-card__text">
        <strong>🔔 {reminder.title}</strong>
        <span className="reminder-card__due">
          {ueberfaellig ? `überfällig – fällig war ${dueLabel(reminder.dueDate)}` : "heute fällig"}
        </span>
        {reminder.description && (
          <div className="reminder-card__desc">{reminder.description}</div>
        )}
        {fehler && <div className="reminder-card__error">{fehler}</div>}
      </div>

      {zeigeTage ? (
        <div className="reminder-card__actions">
          <span className="muted" style={{ fontSize: 13 }}>Um wie viele Tage?</span>
          {Array.from({ length: MAX_POSTPONE_DAYS }, (_, i) => i + 1).map((tage) => (
            <button
              key={tage}
              className="btn btn--sm"
              disabled={laeuft}
              title={`Auf ${tage === 1 ? "morgen" : `in ${tage} Tagen`} verschieben`}
              onClick={() => entscheide("POSTPONED", tage)}
            >
              {tage}
            </button>
          ))}
          <button className="btn btn--sm" onClick={() => setZeigeTage(false)}>
            Abbrechen
          </button>
        </div>
      ) : (
        <div className="reminder-card__actions">
          <button
            className="btn btn--primary"
            disabled={laeuft}
            onClick={() => entscheide("DONE")}
          >
            Erledigt
          </button>
          <button className="btn" disabled={laeuft} onClick={() => setZeigeTage(true)}>
            Verschieben
          </button>
          <button
            className="btn"
            disabled={laeuft || !poolMoeglich}
            title={
              poolMoeglich
                ? "Als Arbeitsschritt in den Pool stellen – ein qualifizierter Mitarbeiter übernimmt"
                : "Dafür braucht die Erinnerung eine Fähigkeit – im Tab Erinnerungen nachtragen"
            }
            onClick={() => entscheide("POOLED")}
          >
            Pool
          </button>
          <button className="btn" disabled={laeuft} onClick={() => entscheide("OBSOLETE")}>
            Hinfällig
          </button>
        </div>
      )}
    </div>
  );
}
