// Erinnerungen: wiederkehrende Dinge, an die jemand denken muss (Wartung,
// Prüfung, Bestellung). Hier werden sie angelegt und gepflegt; entschieden wird
// über sie im Dashboard-Banner (components/ReminderBanner.tsx), sobald sie
// fällig sind.
//
// Erinnerungen sind TAGESGENAU – es gibt keine Uhrzeit. Fällig ist, was heute
// oder früher dran ist; Überfälliges bleibt stehen, bis jemand entscheidet.
import { useState } from "react";
import {
  useCreateReminder,
  useDeleteReminder,
  useReminders,
  useSkills,
  useUpdateReminder,
} from "../api/queries";
import type { Reminder, RepeatRule } from "../api/types";
import type { ReminderInput } from "../api/client";
import { KebabMenu } from "../components/KebabMenu";
import { describeRepeat, dueLabel, isOverdue, todayKey, WEEKDAYS } from "../lib/reminderFormat";

const REPEAT_LABELS: Record<RepeatRule, string> = {
  NONE: "Einmalig",
  DAILY: "Täglich",
  WEEKLY: "Wöchentlich",
  MONTHLY: "Monatlich",
  INTERVAL: "Alle N Tage",
};

const LEER: ReminderInput = {
  title: "",
  description: "",
  dueDate: todayKey(),
  repeatRule: "NONE",
  intervalDays: null,
  weekday: null,
  dayOfMonth: null,
  skillId: null,
};

export function RemindersTab({ isManager }: { isManager: boolean }) {
  const { data: reminders, isLoading } = useReminders();
  const [anlegen, setAnlegen] = useState(false);
  const [bearbeite, setBearbeite] = useState<string | null>(null);

  const aktive = reminders?.filter((r) => r.active) ?? [];
  const ruhende = reminders?.filter((r) => !r.active) ?? [];

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Erinnerungen</h2>
        <span style={{ flex: 1 }} />
        {isManager && !anlegen && (
          <button className="btn btn--primary" onClick={() => setAnlegen(true)}>
            + Neue Erinnerung
          </button>
        )}
      </div>

      <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
        Fällige Erinnerungen erscheinen oben im Dashboard. Dort wird entschieden, was damit
        geschieht – jede Entscheidung landet mit Namen und Uhrzeit im Tagesjournal.
      </p>

      {anlegen && (
        <ReminderForm
          onClose={() => setAnlegen(false)}
          titel="Neue Erinnerung"
        />
      )}

      {isLoading && <p className="muted">Lade…</p>}

      {!isLoading && aktive.length === 0 && !anlegen && (
        <p className="muted">Noch keine Erinnerungen angelegt.</p>
      )}

      {aktive.length > 0 && (
        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Erinnerung</th>
              <th>Nächste Fälligkeit</th>
              <th>Wiederholung</th>
              <th>Fähigkeit</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {aktive.map((r) =>
              bearbeite === r.id ? (
                <tr key={r.id}>
                  <td colSpan={5} style={{ padding: 0 }}>
                    <ReminderForm
                      reminder={r}
                      titel="Erinnerung bearbeiten"
                      onClose={() => setBearbeite(null)}
                    />
                  </td>
                </tr>
              ) : (
                <ReminderRow
                  key={r.id}
                  reminder={r}
                  isManager={isManager}
                  onEdit={() => setBearbeite(r.id)}
                />
              ),
            )}
          </tbody>
        </table>
      )}

      {ruhende.length > 0 && (
        <>
          <h3 style={{ marginBottom: 4 }}>Abgeschlossen</h3>
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Einmalige Erinnerungen, über die bereits entschieden wurde. Sie tauchen nicht mehr
            im Dashboard auf.
          </p>
          <table>
            <thead>
              <tr>
                <th>Erinnerung</th>
                <th>Zuletzt fällig</th>
                <th>Wiederholung</th>
                <th>Fähigkeit</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {ruhende.map((r) => (
                <ReminderRow key={r.id} reminder={r} isManager={isManager} onEdit={() => setBearbeite(r.id)} />
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function ReminderRow({
  reminder,
  isManager,
  onEdit,
}: {
  reminder: Reminder;
  isManager: boolean;
  onEdit: () => void;
}) {
  const update = useUpdateReminder();
  const remove = useDeleteReminder();
  const ueberfaellig = reminder.active && isOverdue(reminder.dueDate);

  return (
    <tr>
      <td>
        <strong>{reminder.title}</strong>
        {reminder.description && (
          <div className="muted" style={{ fontSize: 13 }}>
            {reminder.description}
          </div>
        )}
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        {dueLabel(reminder.dueDate)}
        {ueberfaellig && (
          <span className="badge badge--HIGH" style={{ marginLeft: 6 }}>
            überfällig
          </span>
        )}
      </td>
      <td>{describeRepeat(reminder)}</td>
      <td>{reminder.skill?.name ?? <span className="muted">–</span>}</td>
      <td style={{ textAlign: "right" }}>
        {isManager && (
          <KebabMenu>
            {(close) => (
              <>
                <button
                  className="menu__item"
                  onClick={() => {
                    onEdit();
                    close();
                  }}
                >
                  Bearbeiten
                </button>
                {reminder.active ? (
                  <button
                    className="menu__item"
                    onClick={() => {
                      update.mutate({ id: reminder.id, active: false });
                      close();
                    }}
                  >
                    Pausieren
                  </button>
                ) : (
                  <button
                    className="menu__item"
                    onClick={() => {
                      // Beim Reaktivieren ab HEUTE: der alte Termin liegt in der
                      // Vergangenheit, die Erinnerung stünde sonst sofort als
                      // überfällig im Banner.
                      update.mutate({ id: reminder.id, active: true, dueDate: todayKey() });
                      close();
                    }}
                  >
                    Wieder aktivieren (ab heute)
                  </button>
                )}
                <button
                  className="menu__item menu__item--danger"
                  onClick={() => {
                    remove.mutate(reminder.id);
                    close();
                  }}
                >
                  Löschen
                </button>
              </>
            )}
          </KebabMenu>
        )}
      </td>
    </tr>
  );
}

// Anlegen und Bearbeiten teilen sich dasselbe Formular – die Felder sind
// identisch, nur das Ziel unterscheidet sich.
function ReminderForm({
  reminder,
  titel,
  onClose,
}: {
  reminder?: Reminder;
  titel: string;
  onClose: () => void;
}) {
  const { data: skills } = useSkills();
  const create = useCreateReminder();
  const update = useUpdateReminder();

  const [entwurf, setEntwurf] = useState<ReminderInput>(() =>
    reminder
      ? {
          title: reminder.title,
          description: reminder.description,
          dueDate: reminder.dueDate.slice(0, 10),
          repeatRule: reminder.repeatRule,
          intervalDays: reminder.intervalDays,
          weekday: reminder.weekday,
          dayOfMonth: reminder.dayOfMonth,
          skillId: reminder.skillId,
        }
      : LEER,
  );
  const [fehler, setFehler] = useState<string | null>(null);

  const set = <K extends keyof ReminderInput>(key: K, value: ReminderInput[K]) =>
    setEntwurf((prev) => ({ ...prev, [key]: value }));

  const speichern = () => {
    setFehler(null);
    if (!entwurf.title.trim()) {
      setFehler("Bitte einen Titel angeben.");
      return;
    }
    const onError = (e: unknown) => setFehler(`Speichern fehlgeschlagen: ${String(e)}`);
    if (reminder) {
      update.mutate({ id: reminder.id, ...entwurf }, { onSuccess: onClose, onError });
    } else {
      create.mutate(entwurf, { onSuccess: onClose, onError });
    }
  };

  const laeuft = create.isPending || update.isPending;

  return (
    <div
      style={{
        margin: "12px 0",
        padding: 14,
        background: "var(--hover)",
        borderRadius: "var(--r-md)",
      }}
    >
      <strong>{titel}</strong>

      <div className="step-edit__grid" style={{ marginTop: 10 }}>
        <label>Titel</label>
        <input
          value={entwurf.title}
          placeholder="z. B. Stapler-Sichtprüfung"
          onChange={(e) => set("title", e.target.value)}
        />

        <label>Beschreibung</label>
        <input
          value={entwurf.description ?? ""}
          placeholder="optional – was genau ist zu tun?"
          onChange={(e) => set("description", e.target.value)}
        />

        <label>Erste Fälligkeit</label>
        <input
          type="date"
          value={entwurf.dueDate}
          onChange={(e) => set("dueDate", e.target.value)}
        />

        <label>Wiederholung</label>
        <div className="row row--start" style={{ gap: 8, flexWrap: "wrap" }}>
          <select
            value={entwurf.repeatRule ?? "NONE"}
            onChange={(e) => set("repeatRule", e.target.value as RepeatRule)}
          >
            {(Object.keys(REPEAT_LABELS) as RepeatRule[]).map((rule) => (
              <option key={rule} value={rule}>
                {REPEAT_LABELS[rule]}
              </option>
            ))}
          </select>

          {entwurf.repeatRule === "INTERVAL" && (
            <>
              <span className="muted">alle</span>
              <input
                type="number"
                min={1}
                max={365}
                style={{ width: 80 }}
                value={entwurf.intervalDays ?? 7}
                onChange={(e) => set("intervalDays", Number(e.target.value))}
              />
              <span className="muted">Tage</span>
            </>
          )}

          {entwurf.repeatRule === "WEEKLY" && (
            <select
              value={entwurf.weekday ?? 1}
              onChange={(e) => set("weekday", Number(e.target.value))}
            >
              {WEEKDAYS.map((tag, index) => (
                <option key={index} value={index}>
                  {tag}
                </option>
              ))}
            </select>
          )}

          {entwurf.repeatRule === "MONTHLY" && (
            <>
              <span className="muted">am</span>
              <input
                type="number"
                min={1}
                max={31}
                style={{ width: 80 }}
                value={entwurf.dayOfMonth ?? 1}
                onChange={(e) => set("dayOfMonth", Number(e.target.value))}
              />
              <span className="muted">. des Monats</span>
            </>
          )}
        </div>

        <label>Fähigkeit</label>
        <div>
          <select
            value={entwurf.skillId ?? ""}
            onChange={(e) => set("skillId", e.target.value || null)}
          >
            <option value="">– keine –</option>
            {skills?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <div className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            Nötig für „Pool": Nur mit Fähigkeit kann die Erinnerung als Arbeitsschritt in den
            Pool, den ein qualifizierter Mitarbeiter übernimmt.
          </div>
        </div>
      </div>

      {fehler && (
        <div className="alert" style={{ marginTop: 10 }}>
          {fehler}
        </div>
      )}

      <div className="row row--start" style={{ gap: 8, marginTop: 12 }}>
        <button className="btn btn--primary" disabled={laeuft} onClick={speichern}>
          Speichern
        </button>
        <button className="btn" onClick={onClose}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
