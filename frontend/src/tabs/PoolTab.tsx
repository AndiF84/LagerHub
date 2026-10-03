// Dashboard: laufende Pool-Aufgaben mit Fortschrittsbalken und offenen
// Schritten. Der Manager kann je Schritt einen qualifizierten, freien
// Mitarbeiter manuell einsetzen (Angebot). Der MA nimmt es in der PWA an oder
// ab; bis dahin sind die Annehmen/Ablehnen-Buttons hier ein Test-Ersatz.
// Lehnt ein MA ab, erscheint oben eine Meldung (per Realtime-Event).
import { Fragment, useEffect, useState } from "react";
import {
  useAcceptAssignment,
  useAddStepNote,
  useCompleteAssignment,
  useEmployees,
  useJournal,
  useOfferAssignment,
  usePauseAssignment,
  usePool,
  useRejectAssignment,
  useResumeAssignment,
  useSettings,
  useUpdateTask,
} from "../api/queries";
import { onRealtimeEvent } from "../api/useRealtime";
import { CompletionNotePrompt } from "../components/CompletionNotePrompt";
import { JournalRunCard } from "../components/JournalRunCard";
import { ReminderJournal } from "../components/ReminderJournal";
import { NotesPanel } from "../components/NotesPanel";
import { StepAge } from "../components/StepAge";
import { ReminderBanner } from "../components/ReminderBanner";
import { UtilizationGauge } from "../components/UtilizationGauge";
import { useNow } from "../lib/useNow";
import type { Assignment, Employee, JournalEntry, Step, Task } from "../api/types";

// Prioritäts-Badge-Label je Aufgabe (deutsch; Farben via badge--HIGH/MEDIUM/LOW).
const PRIORITY_LABEL: Record<string, string> = { HIGH: "hoch", MEDIUM: "mittel", LOW: "niedrig" };
// Schritt-Status-Label (deutsch). Wortlaut absichtlich identisch zur PWA
// (pwa/src/components/PoolList.tsx), damit Manager und Mitarbeiter denselben
// Schritt gleich benennen. Die CSS-Klasse hängt weiter am ROHEN Status
// (badge--OPEN/--DONE/…), nur der angezeigte Text ist übersetzt.
const STEP_STATUS_LABEL: Record<string, string> = {
  LOCKED: "gesperrt",
  OPEN: "offen",
  WAITING: "wartet auf Team",
  ACTIVE: "läuft",
  PAUSED: "unterbrochen",
  DONE: "erledigt",
};
// Sortier-Rang (HIGH zuerst); bei gleicher Priorität bleibt die Pool-Reihenfolge.
const PRIORITY_RANK: Record<string, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const byPriority = (a: Task, b: Task) =>
  (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);

// Pro Dashboard-Bereich standardmäßig nur die ersten N Einträge zeigen, damit
// das Dashboard eine stabile Höhe behält.
const SECTION_LIMIT = 3;

// Jeder Bereich reserviert immer die Höhe von SECTION_LIMIT Einträgen – auch
// wenn aktuell weniger (oder keine) da sind –, damit die Bereiche nicht springen.
const CARD_SLOT_PX = 70; // eine eingeklappte Aufgaben-Karte inkl. Abstand
const TABLE_ROW_PX = 34; // eine Journal-Tabellenzeile
const CARD_SECTION_MIN = SECTION_LIMIT * CARD_SLOT_PX;
const JOURNAL_SECTION_MIN = (SECTION_LIMIT + 1) * TABLE_ROW_PX; // Kopfzeile + 3 Zeilen

// Umschalter unter einem Bereich: zeigt entweder die ersten SECTION_LIMIT
// Einträge oder alle. Nur rendern, wenn es mehr als SECTION_LIMIT gibt.
function ShowMoreToggle({
  total,
  expanded,
  onToggle,
}: {
  total: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ textAlign: "center", margin: "4px 0 12px" }}>
      <button className="btn" onClick={onToggle}>
        {expanded ? "▴ Weniger anzeigen" : `▾ Alle ${total} anzeigen`}
      </button>
    </div>
  );
}

interface Rejection {
  key: string;
  employeeName: string;
  stepName: string;
  taskName: string;
}

// Erinnerung an einen MA mit noch unterbrochenem Schritt (WORK_REMINDER).
// Interims-Anzeige im Dashboard als Test-Ersatz, bis die PWA den Push beim MA
// anzeigt.
interface Reminder {
  key: string;
  employeeName: string;
  stepName: string;
  taskName: string;
}

// --- Ein offener Schritt mit Einsatz-Steuerung ----------------------------
function PoolStepRow({
  step,
  employees,
  now,
  escalationMins,
}: {
  step: Step;
  employees: Employee[] | undefined;
  now: number;
  escalationMins: number | undefined;
}) {
  const offer = useOfferAssignment();
  const accept = useAcceptAssignment();
  const reject = useRejectAssignment();
  const pause = usePauseAssignment();
  const resume = useResumeAssignment();
  const complete = useCompleteAssignment();
  const addNote = useAddStepNote();
  const [selected, setSelected] = useState("");
  const [notesOpen, setNotesOpen] = useState(false);
  // Zuweisung, für die gerade die Pflichtnotiz erfragt wird (null = keine).
  // Pro Schritt-Zeile können mehrere MA stehen, deshalb die ID statt eines Flags.
  const [completingId, setCompletingId] = useState<string | null>(null);

  const notes = step.notes ?? [];
  // Erledigte Schritte fahren nur zur Notiz-Bearbeitung mit – keine
  // Einsatz-Steuerung mehr.
  const isDone = step.computedStatus === "DONE";

  const busy = pause.isPending || resume.isPending || complete.isPending;

  const assignments = step.assignments ?? [];
  const offered = assignments.filter((a) => a.state === "OFFERED");
  const working = assignments.filter((a) => a.state === "ACTIVE" || a.state === "PAUSED");

  // Status-Label deutsch (STEP_STATUS_LABEL); WAITING zusätzlich mit der
  // Besetzung (aktiv/min). Fällt auf den rohen Status zurück, falls das Backend
  // einen neuen Status liefert, den die Tabelle noch nicht kennt.
  const status = step.computedStatus ?? "OPEN";
  const activeCount = assignments.filter((a) => a.state === "ACTIVE").length;
  const statusLabel =
    status === "WAITING"
      ? `wartet auf Team (${activeCount}/${step.minWorkers ?? 2})`
      : STEP_STATUS_LABEL[status] ?? status;

  // Voll besetzt, wenn die aktiven MA die Obergrenze erreichen – gleiche
  // Bedingung wie die Backend-Kapazitätsprüfung in activateOnStep (nur ACTIVE
  // zählt; PAUSED gibt den Platz für Ersatz frei). Dann kein Einsetzen mehr
  // anbieten, statt den MA wählen zu lassen und am 409 scheitern zu lassen.
  const isFull = step.maxWorkers != null && activeCount >= step.maxWorkers;

  // Anwesend, qualifiziert (passende Fähigkeit), frei (nicht aktiv) und noch
  // nicht hier eingesetzt/angeboten.
  const busyIds = new Set(assignments.map((a) => a.employee?.id));
  const candidates = (employees ?? []).filter(
    (e) =>
      e.present &&
      e.skills.some((s) => s.skill.id === step.skill.id) &&
      e.status !== "active" &&
      !busyIds.has(e.id),
  );

  const submitOffer = () => {
    if (!selected) return;
    offer.mutate(
      { employeeId: selected, stepId: step.id },
      { onSuccess: () => setSelected("") },
    );
  };

  return (
    <>
    <tr>
      <td>{step.name}</td>
      <td className="muted">{step.skill?.name}</td>
      <td>
        {/* Status + wie lange dieser Zustand schon anhält. Bewusst in derselben
            Zelle: die Zahl ist nur mit dem Status zusammen zu lesen ("offen"
            seit 42 min = Liegenbleiber, "läuft" seit 42 min = normal). */}
        <span className={`badge badge--${status}`}>{statusLabel}</span>
        <StepAge step={step} now={now} escalationMins={escalationMins} />
      </td>
      <td>
        {/* Je MA eine eigene Zeile (.assignees/.assignee in styles.css): Namen
            links, Schaltflächen rechts – beides fluchtet über alle Zeilen. */}
        <div className="assignees">
          {working.map((a: Assignment) => (
            <Fragment key={a.id}>
              <span className={`badge badge--${a.state} assignee__name`}>
                {a.employee?.name}
                {a.state === "PAUSED" ? " · unterbrochen" : ""}
              </span>
              <div className="assignee__actions">
                {a.state === "ACTIVE" ? (
                  <button
                    className="btn"
                    title="Unterbrechen"
                    disabled={busy}
                    onClick={() => pause.mutate(a.id, { onError: (e) => alert(String(e)) })}
                  >
                    Unterbrechen
                  </button>
                ) : (
                  <button
                    className="btn"
                    title="Fortsetzen"
                    disabled={busy}
                    onClick={() => resume.mutate(a.id, { onError: (e) => alert(String(e)) })}
                  >
                    Fortsetzen
                  </button>
                )}
                <button
                  className="btn"
                  title={step.noteRequired ? "Erledigt – Pflichtnotiz nötig" : "Erledigt"}
                  disabled={busy}
                  onClick={() => {
                    // Pflichtnotiz: erst die Eingabe aufklappen, abgeschlossen
                    // wird danach mit dem Wert im selben Request.
                    if (step.noteRequired) setCompletingId(a.id);
                    else complete.mutate({ id: a.id }, { onError: (e) => alert(String(e)) });
                  }}
                >
                  Erledigt{step.noteRequired ? " 📝" : ""}
                </button>
              </div>
            </Fragment>
          ))}
          {offered.map((a: Assignment) => (
            <Fragment key={a.id}>
              <span className="badge badge--PAUSED assignee__name">
                {a.employee?.name} · angeboten
              </span>
              <div className="assignee__actions assignee__actions--icons">
                <button
                  className="btn"
                  title="(Test) annehmen"
                  disabled={accept.isPending}
                  onClick={() => accept.mutate(a.id, { onError: (e) => alert(String(e)) })}
                >
                  ✓
                </button>
                <button
                  className="btn"
                  title="(Test) ablehnen"
                  disabled={reject.isPending}
                  onClick={() => reject.mutate(a.id)}
                >
                  ✗
                </button>
              </div>
            </Fragment>
          ))}
        </div>
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        {isDone ? (
          <span className="muted">erledigt</span>
        ) : isFull ? (
          <span className="muted" title="Maximale Mitarbeiterzahl erreicht">
            ● voll besetzt ({activeCount}/{step.maxWorkers})
          </span>
        ) : (
          <>
            <select value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">– Mitarbeiter –</option>
              {candidates.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>{" "}
            <button className="btn" onClick={submitOffer} disabled={!selected || offer.isPending}>
              Einsetzen
            </button>
            {candidates.length === 0 && (
              <div className="muted">Kein freier, qualifizierter MA</div>
            )}
            {offer.isError && <div className="muted">{String(offer.error)}</div>}
          </>
        )}
      </td>
      <td style={{ whiteSpace: "nowrap" }}>
        <button
          className="btn"
          onClick={() => setNotesOpen((v) => !v)}
          aria-expanded={notesOpen}
          title="Notizen anzeigen/ausblenden"
        >
          📝 {notes.length > 0 ? notes.length : ""}
        </button>
      </td>
    </tr>
    {completingId && (
      <tr>
        <td colSpan={6} style={{ background: "rgba(0,0,0,0.03)" }}>
          <CompletionNotePrompt
            label={step.noteLabel}
            format={step.noteFormat}
            pending={complete.isPending}
            onCancel={() => setCompletingId(null)}
            onSubmit={(note) =>
              complete.mutate(
                { id: completingId, note },
                {
                  onSuccess: () => setCompletingId(null),
                  onError: (e) => alert(String(e)),
                },
              )
            }
          />
        </td>
      </tr>
    )}
    {notesOpen && (
      <tr>
        <td colSpan={6} style={{ background: "rgba(0,0,0,0.03)" }}>
          <NotesPanel
            notes={notes}
            pending={addNote.isPending}
            onAdd={(text) =>
              addNote.mutate({ stepId: step.id, text }, { onError: (e) => alert(String(e)) })
            }
          />
        </td>
      </tr>
    )}
    </>
  );
}

function PoolTaskCard({
  task,
  employees,
  now,
  escalationMins,
}: {
  task: Task;
  employees: Employee[] | undefined;
  now: number;
  escalationMins: number | undefined;
}) {
  // Karten standardmäßig eingeklappt (nur Kopfzeile); Schritte per Klick öffnen.
  const [expanded, setExpanded] = useState(false);
  const updateTask = useUpdateTask();

  const total = task.stepsTotal ?? task.steps.length;
  const done = task.stepsDone ?? 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  // Entfernbar nur, solange KEIN Schritt je begonnen wurde (task.startedAt ===
  // null). Sobald ein Schritt begonnen wurde – auch wenn er bereits erledigt ist
  // und alle weiteren wieder offen sind – bleibt die Aufgabe „in Bearbeitung"
  // und ist nicht entfernbar. poolEnabled=false → verschwindet aus dem
  // Dashboard, bleibt aber unter „Aufgaben" erhalten.
  const removable = task.startedAt == null;

  // Wer sitzt gerade auf einem Schritt dieser Aufgabe? Beim Entfernen löst das
  // Backend diese Zuweisungen auf (es lief kein Timer, also geht keine
  // Arbeitszeit verloren) – der MA wird damit aber ohne Zutun ausgeloggt.
  // Deshalb vorher nachfragen, statt es still zu tun. Angebote (OFFERED) sind
  // unverbindlich und bleiben hier bewusst außen vor.
  const eingeloggt = Array.from(
    new Set(
      task.steps.flatMap((step) =>
        step.assignments
          .filter((a) => a.state === "ACTIVE" || a.state === "PAUSED")
          .map((a) => a.employee.name),
      ),
    ),
  );

  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const doRemove = () => {
    setConfirmingRemove(false);
    updateTask.mutate(
      { id: task.id, poolEnabled: false },
      { onError: (e) => alert(`Entfernen fehlgeschlagen: ${String(e)}`) },
    );
  };
  // Ohne eingeloggte MA gibt es nichts zu bestätigen – dann direkt entfernen.
  const removeFromPool = () =>
    eingeloggt.length > 0 ? setConfirmingRemove(true) : doRemove();

  return (
    <div className="card task-card">
      <div className="row" style={{ gap: 12 }}>
        <button
          className="btn"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          title={expanded ? "Schritte einklappen" : "Schritte aufklappen"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <strong style={{ whiteSpace: "nowrap" }}>{task.name}</strong>
        <span className={`badge badge--${task.priority}`}>
          {PRIORITY_LABEL[task.priority] ?? task.priority}
        </span>
        <div className="progress" title={`${done} von ${total} Schritten erledigt`}>
          <div className="progress__fill" style={{ width: `${percent}%` }} />
        </div>
        <span className="muted" style={{ whiteSpace: "nowrap" }}>
          {done} / {total} Schritte
        </span>
        {removable && (
          <button
            className="btn"
            style={{ marginLeft: "auto", whiteSpace: "nowrap" }}
            disabled={updateTask.isPending}
            title="Aufgabe aus dem Pool/Dashboard entfernen (bleibt unter Aufgaben erhalten)"
            onClick={removeFromPool}
          >
            Aus Pool entfernen
          </button>
        )}
      </div>

      {/* Rückfrage als eigene Leiste unter dem Kopf (gleiches Muster wie die
          Start-Bestätigung im Aufgaben-Tab): kein blockierendes confirm(), und
          der Kartenkopf bleibt stabil. */}
      {confirmingRemove && (
        <div
          className="row"
          style={{
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            marginTop: 8,
            padding: "8px 10px",
            background: "var(--hover)",
            borderRadius: "var(--r-sm)",
          }}
        >
          <span style={{ fontSize: 13 }}>
            <strong>{eingeloggt.join(", ")}</strong>{" "}
            {eingeloggt.length === 1 ? "ist" : "sind"} auf einem Schritt dieser Aufgabe
            eingeloggt und {eingeloggt.length === 1 ? "wird" : "werden"} dabei ausgeloggt.
            <span className="muted">
              {" "}
              Es wurde noch keine Arbeitszeit gebucht – es geht nichts verloren.
            </span>
          </span>
          <span style={{ flex: "1 1 auto" }} />
          <button
            className="btn btn--primary"
            disabled={updateTask.isPending}
            onClick={doRemove}
          >
            Ja, entfernen
          </button>
          <button className="btn" onClick={() => setConfirmingRemove(false)}>
            Abbrechen
          </button>
        </div>
      )}

      {expanded && (
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Schritt</th>
              <th>Fähigkeit</th>
              <th>Status</th>
              <th>Mitarbeiter</th>
              <th>Einsetzen</th>
              <th>Notizen</th>
            </tr>
          </thead>
          <tbody>
            {task.steps.map((step) => (
              <PoolStepRow
                key={step.id}
                step={step}
                employees={employees}
                now={now}
                escalationMins={escalationMins}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// --- Tagesjournal: heute abgeschlossene Durchläufe -----------------------
function JournalSection({ entries }: { entries: JournalEntry[] | undefined }) {
  const [showAll, setShowAll] = useState(false);
  const all = entries ?? [];
  const visible = showAll ? all : all.slice(0, SECTION_LIMIT);

  return (
    <div style={{ marginTop: 24 }}>
      <h2 style={{ fontSize: 16 }}>Tagesjournal – heute erledigt</h2>
      <div style={{ minHeight: JOURNAL_SECTION_MIN }}>
        {entries && all.length === 0 && (
          <p className="muted">Heute wurde noch keine Aufgabe abgeschlossen.</p>
        )}
        {visible.map((e) => (
          <JournalRunCard key={e.id} run={e} />
        ))}
        {/* Heutige Erinnerungs-Entscheidungen: gehören ins Tagesjournal,
            sind aber kein Arbeits-Durchlauf (eigene Zeile, eigene Quelle). */}
        <ReminderJournal />
      </div>
      {all.length > SECTION_LIMIT && (
        <ShowMoreToggle total={all.length} expanded={showAll} onToggle={() => setShowAll((v) => !v)} />
      )}
    </div>
  );
}

export function PoolTab() {
  const { data: pool, isLoading, isError, error } = usePool();
  const { data: employees } = useEmployees();
  const { data: journal } = useJournal();
  // Alter der Schritte: EIN Takt für die ganze Seite (nicht je Zeile ein eigener
  // Timer). 30 s reichen für eine Anzeige in ganzen Minuten.
  const now = useNow(30_000);
  const { data: settings } = useSettings();
  const [rejections, setRejections] = useState<Rejection[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [showAllRunning, setShowAllRunning] = useState(false);
  const [showAllOpen, setShowAllOpen] = useState(false);

  // Aufteilen danach, ob bereits ein Schritt begonnen wurde (task.startedAt).
  // „In Bearbeitung" = Arbeit hat begonnen (bleibt dort, auch wenn aktuell kein
  // Schritt aktiv ist, z. B. ein Schritt erledigt + Rest offen). „Offen – noch
  // nicht begonnen" = es wurde noch kein Schritt gestartet.
  const running = pool?.filter((t) => t.startedAt != null).sort(byPriority) ?? [];
  const open = pool?.filter((t) => t.startedAt == null).sort(byPriority) ?? [];
  const visibleRunning = showAllRunning ? running : running.slice(0, SECTION_LIMIT);
  const visibleOpen = showAllOpen ? open : open.slice(0, SECTION_LIMIT);

  // Ablehnungen und Erinnerungen als Banner sammeln (Realtime-Events vom Backend).
  useEffect(() => {
    return onRealtimeEvent((msg) => {
      if (msg.type === "ASSIGNMENT_REJECTED") {
        setRejections((prev) => [
          {
            key: `${String(msg.assignmentId)}-${Date.now()}`,
            employeeName: String(msg.employeeName ?? "Mitarbeiter"),
            stepName: String(msg.stepName ?? ""),
            taskName: String(msg.taskName ?? ""),
          },
          ...prev,
        ]);
      } else if (msg.type === "WORK_REMINDER") {
        setReminders((prev) => [
          {
            key: `${String(msg.stepId)}-${Date.now()}`,
            employeeName: String(msg.employeeName ?? "Mitarbeiter"),
            stepName: String(msg.stepName ?? ""),
            taskName: String(msg.taskName ?? ""),
          },
          ...prev,
        ]);
      }
    });
  }, []);

  return (
    <div>
      {rejections.map((r) => (
        <div key={r.key} className="alert alert--warn">
          <span>
            <strong>{r.employeeName}</strong> hat den Schritt „{r.stepName}" in Aufgabe „
            {r.taskName}" abgelehnt.
          </span>
          <button
            className="alert__close"
            title="Schließen"
            onClick={() => setRejections((prev) => prev.filter((x) => x.key !== r.key))}
          >
            ×
          </button>
        </div>
      ))}

      {reminders.map((r) => (
        <div key={r.key} className="alert alert--info">
          <span>
            ⏸ <strong>{r.employeeName}</strong> hat den Schritt „{r.stepName}" in Aufgabe „
            {r.taskName}" noch unterbrochen – nicht beendet.
          </span>
          <button
            className="alert__close"
            title="Schließen"
            onClick={() => setReminders((prev) => prev.filter((x) => x.key !== r.key))}
          >
            ×
          </button>
        </div>
      ))}

      {/* Fällige Erinnerungen stehen GANZ oben – vor Auslastung und Aufgaben.
          Sie sind das, was beim morgendlichen Blick aufs Dashboard zuerst eine
          Entscheidung braucht. */}
      <ReminderBanner />

      {isLoading && <p className="muted">Lade Pool…</p>}
      {isError && <p className="muted">Fehler: {String(error)}</p>}

      <UtilizationGauge pool={pool} employees={employees} />

      <h2 style={{ fontSize: 16 }}>In Bearbeitung</h2>
      <div style={{ minHeight: CARD_SECTION_MIN }}>
        {!isLoading && running.length === 0 && (
          <p className="muted">Aktuell wird an keiner Aufgabe gearbeitet.</p>
        )}
        {visibleRunning.map((task) => (
          <PoolTaskCard
            key={task.id}
            task={task}
            employees={employees}
            now={now}
            escalationMins={settings?.escalationMins}
          />
        ))}
      </div>
      {running.length > SECTION_LIMIT && (
        <ShowMoreToggle
          total={running.length}
          expanded={showAllRunning}
          onToggle={() => setShowAllRunning((v) => !v)}
        />
      )}

      <h2 style={{ fontSize: 16, marginTop: 24 }}>Offen – noch nicht begonnen</h2>
      <div style={{ minHeight: CARD_SECTION_MIN }}>
        {!isLoading && open.length === 0 && (
          <p className="muted">
            Keine offenen Aufgaben. Aufgaben werden über „Aufgaben → Starten" in den Pool gestellt.
          </p>
        )}
        {visibleOpen.map((task) => (
          <PoolTaskCard
            key={task.id}
            task={task}
            employees={employees}
            now={now}
            escalationMins={settings?.escalationMins}
          />
        ))}
      </div>
      {open.length > SECTION_LIMIT && (
        <ShowMoreToggle
          total={open.length}
          expanded={showAllOpen}
          onToggle={() => setShowAllOpen((v) => !v)}
        />
      )}

      <JournalSection entries={journal} />
    </div>
  );
}
