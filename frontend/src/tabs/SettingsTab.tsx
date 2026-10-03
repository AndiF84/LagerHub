// Einstellungen – ADMIN-exklusiv (TAB_ACCESS in api/session.ts, serverseitig
// authAdmin auf PATCH /settings). Sammelt die Betriebsparameter, die vorher nur
// per direktem API-Aufruf änderbar waren: Arbeitszeiten, Eskalations-Schwelle
// und Pause. Die Journal-Aufbewahrung ist aus dem Historie-Tab hierher gezogen –
// sie gehört sachlich zu den Einstellungen, nicht zur Tagesansicht.
import { useState, type ReactNode } from "react";
import { useSettings, useUpdateSettings } from "../api/queries";
import type { Settings } from "../api/types";
import { formatMinutes } from "../lib/formatDuration";

// Eine Karte je Themenblock. Jede hält ihren eigenen Entwurf und speichert
// einzeln – so verliert ein Tippfehler in der Pause nicht die Arbeitszeiten,
// und der Speichern-Knopf schreibt jeweils nur seinen eigenen Block.
function Card({
  title,
  hint,
  children,
  onSave,
  dirty,
  pending,
  error,
}: {
  title: string;
  hint: ReactNode;
  children: ReactNode;
  onSave: () => void;
  dirty: boolean;
  pending: boolean;
  error: unknown;
}) {
  return (
    <div className="card">
      <h2 style={{ fontSize: 16, marginTop: 0 }}>{title}</h2>
      <div
        className="row row--start"
        style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}
      >
        {children}
        <button className="btn" disabled={!dirty || pending} onClick={onSave}>
          Speichern
        </button>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        {hint}
      </p>
      {Boolean(error) && <p className="muted">Fehler: {String(error)}</p>}
    </div>
  );
}

const timeInput = { padding: "4px 8px", width: 110 };
const numInput = { padding: "4px 8px", width: 80 };

export function SettingsTab() {
  const { data: settings, isLoading } = useSettings();

  if (isLoading || !settings) {
    return (
      <div className="card">
        <p className="muted">Einstellungen werden geladen…</p>
      </div>
    );
  }

  // key erzwingt frische Entwurfs-States, wenn der Server andere Werte liefert
  // (z. B. via SETTINGS_UPDATED aus einer zweiten Sitzung) – sonst zeigte das
  // Formular weiter den alten Stand und „Speichern" bliebe grundlos aktiv.
  return <SettingsForms key={JSON.stringify(settings)} settings={settings} />;
}

function SettingsForms({ settings }: { settings: Settings }) {
  const update = useUpdateSettings();

  const [workStart, setWorkStart] = useState(settings.workStart);
  const [workEnd, setWorkEnd] = useState(settings.workEnd);
  const [escalationMins, setEscalationMins] = useState(settings.escalationMins);
  const [breakStart, setBreakStart] = useState(settings.breakStart);
  const [breakEnd, setBreakEnd] = useState(settings.breakEnd);
  const [days, setDays] = useState(settings.journalRetentionDays);

  // Fehler nur an der Karte zeigen, die ihn ausgelöst hat: sonst blendet ein
  // abgelehntes Speichern der Pause eine Meldung unter den Arbeitszeiten ein.
  const [failed, setFailed] = useState<string | null>(null);
  const save = (block: string, body: Partial<Settings>) => {
    setFailed(null);
    update.mutate(body, { onError: () => setFailed(block) });
  };
  const errorOf = (block: string) =>
    failed === block && update.isError ? update.error : null;

  const breakOff = breakStart === breakEnd;

  return (
    <div style={{ display: "grid", gap: 16, maxWidth: 760 }}>
      <Card
        title="Arbeitszeiten"
        dirty={workStart !== settings.workStart || workEnd !== settings.workEnd}
        pending={update.isPending}
        error={errorOf("work")}
        onSave={() => save("work", { workStart, workEnd })}
        hint={
          <>
            Außerhalb dieses Fensters wird nicht eskaliert. Zum Feierabend werden
            laufende Zuweisungen von Mitarbeitern <strong>ohne</strong>{" "}
            Zeiterfassung unterbrochen, zum Arbeitsbeginn erinnert – wer gestempelt
            wird, folgt stattdessen seinem Stempel.
          </>
        }
      >
        <span>Von</span>
        <input
          type="time"
          value={workStart}
          onChange={(e) => setWorkStart(e.target.value)}
          style={timeInput}
        />
        <span>bis</span>
        <input
          type="time"
          value={workEnd}
          onChange={(e) => setWorkEnd(e.target.value)}
          style={timeInput}
        />
      </Card>

      <Card
        title="Eskalation"
        dirty={escalationMins !== settings.escalationMins}
        pending={update.isPending}
        error={errorOf("esc")}
        onSave={() => save("esc", { escalationMins })}
        hint={
          <>
            Ein unbesetzter Schritt einer Aufgabe mit <strong>hoher</strong>{" "}
            Priorität gilt nach {formatMinutes(escalationMins)} als überfällig:
            Meldung im Dashboard und Push an die qualifizierten Mitarbeiter, danach{" "}
            <strong>jede Minute erneut</strong>, bis jemand übernimmt. Derselbe Wert
            färbt die Alters-Anzeige an den Schritten – ab der Hälfte gelb, ab dem
            vollen Wert rot.
          </>
        }
      >
        <span>Überfällig nach</span>
        <input
          type="number"
          min={1}
          max={1440}
          value={escalationMins}
          onChange={(e) =>
            setEscalationMins(Math.max(1, Math.min(1440, Number(e.target.value) || 1)))
          }
          style={numInput}
        />
        <span>Minuten</span>
      </Card>

      <Card
        title="Pause"
        dirty={breakStart !== settings.breakStart || breakEnd !== settings.breakEnd}
        pending={update.isPending}
        error={errorOf("break")}
        onSave={() => save("break", { breakStart, breakEnd })}
        hint={
          breakOff ? (
            <>
              Keine Pause – die Eskalation läuft durchgehend. Gleiche Anfangs- und
              Endzeit schaltet sie ab.
            </>
          ) : (
            <>
              Zwischen {breakStart} und {breakEnd} wird <strong>nicht</strong>{" "}
              eskaliert – dort ist niemand da, der übernehmen könnte. Ab {breakEnd}{" "}
              meldet sich ein noch liegender Schritt von selbst wieder: es geht
              nichts verloren, es wird nur später gemeldet. Neue Aufgaben mit hoher
              Priorität melden sich weiterhin sofort. Gleiche Anfangs- und Endzeit =
              keine Pause.
            </>
          )
        }
      >
        <span>Von</span>
        <input
          type="time"
          value={breakStart}
          onChange={(e) => setBreakStart(e.target.value)}
          style={timeInput}
        />
        <span>bis</span>
        <input
          type="time"
          value={breakEnd}
          onChange={(e) => setBreakEnd(e.target.value)}
          style={timeInput}
        />
      </Card>

      <Card
        title="Automatische Löschung"
        dirty={days !== settings.journalRetentionDays}
        pending={update.isPending}
        error={errorOf("retention")}
        onSave={() => save("retention", { journalRetentionDays: days })}
        hint={
          days === 0 ? (
            <>Deaktiviert – es wird nichts automatisch gelöscht. 0 = deaktiviert.</>
          ) : (
            <>
              Tagesjournale, die älter als {days} Tage sind, werden automatisch
              entfernt – <strong>mitsamt den Auswertungs-Daten</strong> dieser Läufe.
              Das lässt sich nicht rückgängig machen. Aufgeräumt wird nachts um 03:00
              und sofort beim Speichern. 0 = deaktiviert.
            </>
          )
        }
      >
        <span>Tagesjournale löschen nach</span>
        <input
          type="number"
          min={0}
          max={3650}
          value={days}
          onChange={(e) => setDays(Math.max(0, Math.min(3650, Number(e.target.value) || 0)))}
          style={numInput}
        />
        <span>Tagen</span>
      </Card>
    </div>
  );
}
