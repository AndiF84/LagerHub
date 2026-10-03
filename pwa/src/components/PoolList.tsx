// M2 – mobile Arbeitsansicht des Mitarbeiters: seine nach Fähigkeiten gefilterten,
// freigegebenen Schritte je Aufgabe (einloggen / abschließen / unterbrechen /
// fortsetzen).
// M3 – zusätzlich Manager-Angebote annehmen/ablehnen und MA-Notizen anhängen.
// Push (M4) folgt.
import { useState } from "react";
import {
  usePool,
  useAssignSelf,
  useCompleteAssignment,
  usePauseAssignment,
  useResumeAssignment,
  useLeaveAssignment,
  useAcceptOffer,
  useRejectOffer,
  useAddNote,
  useSettings,
} from "../api/queries";
import { CompletionNotePrompt } from "./CompletionNotePrompt";
import { NotesPanel } from "./NotesPanel";
import { StepAge } from "./StepAge";
import { useNow } from "../lib/useNow";
import type { MaUser, PoolStep, PoolTask, Priority } from "../api/types";

const STATUS_LABEL: Record<string, string> = {
  OPEN: "offen",
  WAITING: "wartet auf Team",
  ACTIVE: "läuft",
  PAUSED: "unterbrochen",
  DONE: "erledigt",
};
const STATUS_CLASS: Record<string, string> = {
  OPEN: "badge",
  WAITING: "badge badge--warn",
  ACTIVE: "badge badge--ok",
  PAUSED: "badge badge--warn",
  DONE: "badge badge--muted",
};
// Prioritäts-Badge je Aufgabe (rot/amber/grau, wie im Dashboard).
const PRIORITY_BADGE: Record<Priority, { label: string; cls: string }> = {
  HIGH: { label: "hoch", cls: "badge badge--high" },
  MEDIUM: { label: "mittel", cls: "badge badge--warn" },
  LOW: { label: "niedrig", cls: "badge badge--muted" },
};

// Beteiligung des MA an einer Aufgabe: hat er auf einem (nicht erledigten)
// Schritt eine laufende Zuweisung → "active"; sonst eine unterbrochene →
// "paused"; sonst nur offen/wählbar → "open". Steuert die Gruppierung/Sortierung
// der Arbeitsansicht (aktiv oben, unterbrochen darunter, Rest abgesetzt).
type TaskGroup = "active" | "paused" | "open";
function classifyTask(task: PoolTask, userId: string): TaskGroup {
  let hasPaused = false;
  for (const step of task.steps) {
    if (step.computedStatus === "DONE") continue;
    for (const a of step.assignments) {
      if (a.employee.id !== userId) continue;
      if (a.state === "ACTIVE") return "active";
      if (a.state === "PAUSED") hasPaused = true;
    }
  }
  return hasPaused ? "paused" : "open";
}

// Fehlermeldungen des Wrappers in etwas MA-Taugliches übersetzen.
function actionErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("voll")) return "Der Schritt ist gerade voll besetzt.";
  if (msg.includes("nicht anwesend")) return "Du bist als abwesend gemeldet – bitte beim Manager melden.";
  if (msg.includes("Fähigkeit")) return "Dir fehlt die nötige Fähigkeit für diesen Schritt.";
  if (msg.includes("nicht (mehr) offen")) return "Das Angebot ist nicht mehr offen.";
  if (msg.includes("läuft bereits")) return "Der Schritt läuft schon – bitte abschließen oder unterbrechen.";
  return msg;
}

export function PoolList({ user }: { user: MaUser }) {
  const pool = usePool(user.id);
  // Ein Takt für die ganze Liste (nicht je Zeile ein Timer); 30 s genügen für
  // eine Anzeige in ganzen Minuten und schonen den Handy-Akku.
  const now = useNow(30_000);
  const { data: settings } = useSettings();
  // Genau eine Aktion zur Zeit (mobile, ein MA): id des Schritts in Arbeit +
  // eine Fehlermeldung. Beim Erfolg aktualisiert das WS-Event den Pool.
  const [busyStepId, setBusyStepId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const assignSelf = useAssignSelf();
  const complete = useCompleteAssignment();
  const pause = usePauseAssignment();
  const resume = useResumeAssignment();
  const leave = useLeaveAssignment();
  const accept = useAcceptOffer();
  const reject = useRejectOffer();
  const addNote = useAddNote();

  const run = (stepId: string, p: Promise<unknown>) => {
    setBusyStepId(stepId);
    setError(null);
    return p.catch((e) => setError(actionErrorText(e))).finally(() => setBusyStepId(null));
  };

  if (pool.isLoading) return <p className="muted">Lädt…</p>;
  if (pool.isError) return <p className="error">Pool konnte nicht geladen werden.</p>;

  const tasks = pool.data ?? [];
  if (tasks.length === 0) {
    return (
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Nichts zu tun 👍</h1>
        <p className="muted">Aktuell gibt es keine passenden, freigegebenen Schritte für dich.</p>
      </div>
    );
  }

  // In "meine Arbeit" (aktiv/unterbrochen, oben) und "verfügbar" (Rest) trennen,
  // je Gruppe nach Priorität (HIGH zuerst). Sort ist stabil → bei gleicher
  // Priorität bleibt die Pool-Reihenfolge erhalten.
  const rank: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const byPriority = (a: PoolTask, b: PoolTask) => rank[a.priority] - rank[b.priority];
  const active = tasks.filter((t) => classifyTask(t, user.id) === "active").sort(byPriority);
  const paused = tasks.filter((t) => classifyTask(t, user.id) === "paused").sort(byPriority);
  const open = tasks.filter((t) => classifyTask(t, user.id) === "open").sort(byPriority);

  const renderTask = (task: PoolTask) => (
    <TaskCard
      key={task.id}
      task={task}
      group={classifyTask(task, user.id)}
      userId={user.id}
      busyStepId={busyStepId}
      notePending={addNote.isPending}
      now={now}
      escalationMins={settings?.escalationMins}
      onLogin={(step) => run(step.id, assignSelf.mutateAsync(step.id))}
      onComplete={(step, aid, note) => run(step.id, complete.mutateAsync({ id: aid, note }))}
      onPause={(step, aid) => run(step.id, pause.mutateAsync(aid))}
      onResume={(step, aid) => run(step.id, resume.mutateAsync(aid))}
      onLeave={(step, aid) => run(step.id, leave.mutateAsync(aid))}
      onAccept={(step, aid) => run(step.id, accept.mutateAsync(aid))}
      onReject={(step, aid) => run(step.id, reject.mutateAsync(aid))}
      onAddNote={(step, text) => run(step.id, addNote.mutateAsync({ stepId: step.id, text }))}
    />
  );

  const hasMine = active.length > 0 || paused.length > 0;

  return (
    <div className="pool">
      {error && <p className="error error--banner">{error}</p>}

      {hasMine && (
        <section className="pool-group pool-group--mine">
          <h2 className="pool-group__title">Meine Arbeit</h2>
          {active.map(renderTask)}
          {paused.map(renderTask)}
        </section>
      )}

      {open.length > 0 && (
        <section className="pool-group pool-group--open">
          <h2 className="pool-group__title">Verfügbare Aufgaben</h2>
          {open.map(renderTask)}
        </section>
      )}
    </div>
  );
}

type StepHandlers = {
  onLogin: (step: PoolStep) => void;
  // `note` = Pflichtnotiz bei Schritten mit noteRequired (sonst undefined).
  onComplete: (step: PoolStep, assignmentId: string, note?: string) => void;
  onPause: (step: PoolStep, assignmentId: string) => void;
  onResume: (step: PoolStep, assignmentId: string) => void;
  onLeave: (step: PoolStep, assignmentId: string) => void;
  onAccept: (step: PoolStep, assignmentId: string) => void;
  onReject: (step: PoolStep, assignmentId: string) => void;
  onAddNote: (step: PoolStep, text: string) => void;
};

function TaskCard({
  task,
  group,
  userId,
  busyStepId,
  notePending,
  now,
  escalationMins,
  ...handlers
}: {
  task: PoolTask;
  group: TaskGroup;
  userId: string;
  busyStepId: string | null;
  notePending: boolean;
  now: number;
  escalationMins: number | undefined;
} & StepHandlers) {
  // Erledigte Schritte blendet die Arbeitsansicht aus (nur offene Arbeit zeigen);
  // der Fortschritt steht ohnehin im Kopf der Karte.
  const steps = task.steps.filter((s) => s.computedStatus !== "DONE");
  if (steps.length === 0) return null;

  const groupClass =
    group === "active" ? " task-card--active" : group === "paused" ? " task-card--paused" : "";

  return (
    <div className={`card task-card${groupClass}`}>
      <div className="task-card__head">
        <strong>{task.name}</strong>
        <span className={PRIORITY_BADGE[task.priority].cls}>{PRIORITY_BADGE[task.priority].label}</span>
        <span style={{ flex: 1 }} />
        <span className="muted">
          {task.stepsDone}/{task.stepsTotal} erledigt
        </span>
      </div>
      <ul className="step-list">
        {steps.map((step) => (
          <StepRow
            key={step.id}
            step={step}
            userId={userId}
            busy={busyStepId === step.id}
            anyBusy={busyStepId !== null}
            notePending={notePending}
            now={now}
            escalationMins={escalationMins}
            {...handlers}
          />
        ))}
      </ul>
    </div>
  );
}

function StepRow({
  step,
  userId,
  busy,
  anyBusy,
  notePending,
  now,
  escalationMins,
  onLogin,
  onComplete,
  onPause,
  onResume,
  onLeave,
  onAccept,
  onReject,
  onAddNote,
}: {
  step: PoolStep;
  userId: string;
  busy: boolean;
  anyBusy: boolean;
  notePending: boolean;
  now: number;
  escalationMins: number | undefined;
} & StepHandlers) {
  const [notesOpen, setNotesOpen] = useState(false);
  // Läuft gerade die Abfrage der Pflichtnotiz? (id der Zuweisung, die dann
  // abgeschlossen wird – null = keine Abfrage offen.)
  const [completingId, setCompletingId] = useState<string | null>(null);

  // Meine (aktive/unterbrochene) Zuweisung bzw. ein an mich gerichtetes Angebot.
  const mine = step.assignments.find(
    (a) => a.employee.id === userId && (a.state === "ACTIVE" || a.state === "PAUSED"),
  );
  const myOffer = step.assignments.find(
    (a) => a.employee.id === userId && a.state === "OFFERED",
  );
  const activeCount = step.assignments.filter((a) => a.state === "ACTIVE").length;
  const isTeam = (step.minWorkers ?? 0) >= 2;
  const full = step.maxWorkers !== null && activeCount >= step.maxWorkers;
  // Abschließen erst erlaubt, wenn der Schritt wirklich läuft: Einzel-Schritt immer,
  // Team-Schritt nur wenn die Mindestbesetzung erreicht war (startedAt gesetzt).
  // Verhindert, dass ein einzelner MA einen noch wartenden Team-Schritt beendet.
  const canComplete = !isTeam || step.startedAt !== null;
  // Andere aktive/unterbrochene MA am Schritt (ohne mich) – nur zur Info.
  const others = step.assignments
    .filter((a) => a.employee.id !== userId && (a.state === "ACTIVE" || a.state === "PAUSED"))
    .map((a) => a.employee.name);

  const disabled = busy || anyBusy;

  // Bei Pflichtnotiz zuerst die Eingabe aufklappen; abgeschlossen wird danach
  // mit dem Wert im selben Request (Backend prüft ihn erneut).
  const requestComplete = (assignmentId: string) => {
    if (step.noteRequired) setCompletingId(assignmentId);
    else onComplete(step, assignmentId);
  };

  return (
    <li className={`step-row${myOffer ? " step-row--offer" : ""}`}>
      <div className="step-row__main">
        {myOffer ? (
          <span className="badge badge--offer">Angebot für dich</span>
        ) : (
          <span className={STATUS_CLASS[step.computedStatus] ?? "badge"}>
            {STATUS_LABEL[step.computedStatus] ?? step.computedStatus}
          </span>
        )}
        <span className="step-row__name">{step.name}</span>
        {isTeam && (
          <span className="muted step-row__team">
            Team {activeCount}/{step.minWorkers}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {/* Alter rechts vor der Notiz-Schaltfläche: auf dem schmalen Display
            würde es links den Schrittnamen umbrechen lassen. */}
        <StepAge step={step} now={now} escalationMins={escalationMins} />
        <button
          className="btn step-row__notes-btn"
          onClick={() => setNotesOpen((v) => !v)}
          aria-expanded={notesOpen}
        >
          📝{step.notes.length > 0 ? ` ${step.notes.length}` : ""}
        </button>
      </div>
      {others.length > 0 && <div className="muted step-row__others">mit {others.join(", ")}</div>}

      <div className="step-row__actions">
        {myOffer && (
          <>
            <button className="btn btn--primary" disabled={disabled} onClick={() => onAccept(step, myOffer.id)}>
              Annehmen
            </button>
            <button className="btn" disabled={disabled} onClick={() => onReject(step, myOffer.id)}>
              Ablehnen
            </button>
          </>
        )}
        {/* Team-Schritt noch nicht gestartet (WAITING): der eingeloggte MA wartet
            auf weitere – hier kein Abschließen/Unterbrechen, sondern „Ausloggen"
            (Platz freigeben, falls sich das Team vor Beginn umstellt). */}
        {!myOffer && mine?.state === "ACTIVE" && step.computedStatus === "WAITING" && (
          <button className="btn" disabled={disabled} onClick={() => onLeave(step, mine.id)}>
            Ausloggen
          </button>
        )}
        {!myOffer && mine?.state === "ACTIVE" && step.computedStatus !== "WAITING" && (
          <>
            <button
              className="btn btn--primary"
              disabled={disabled}
              onClick={() => requestComplete(mine.id)}
            >
              Abschließen{step.noteRequired ? " 📝" : ""}
            </button>
            <button className="btn" disabled={disabled} onClick={() => onPause(step, mine.id)}>
              Unterbrechen
            </button>
          </>
        )}
        {!myOffer && mine?.state === "PAUSED" && (
          <>
            <button className="btn btn--primary" disabled={disabled} onClick={() => onResume(step, mine.id)}>
              Fortsetzen
            </button>
            {canComplete ? (
              <button className="btn" disabled={disabled} onClick={() => requestComplete(mine.id)}>
                Abschließen{step.noteRequired ? " 📝" : ""}
              </button>
            ) : (
              // Team-Schritt noch nicht gestartet: nicht abschließbar, stattdessen
              // den Platz freigeben können.
              <button className="btn" disabled={disabled} onClick={() => onLeave(step, mine.id)}>
                Ausloggen
              </button>
            )}
          </>
        )}
        {!myOffer &&
          !mine &&
          (full ? (
            <span className="muted step-row__full">● voll besetzt ({activeCount}/{step.maxWorkers})</span>
          ) : (
            <button className="btn btn--primary" disabled={disabled} onClick={() => onLogin(step)}>
              Einloggen
            </button>
          ))}
      </div>

      {completingId && (
        <CompletionNotePrompt
          label={step.noteLabel}
          format={step.noteFormat}
          pending={busy}
          onCancel={() => setCompletingId(null)}
          onSubmit={(note) => {
            setCompletingId(null);
            onComplete(step, completingId, note);
          }}
        />
      )}

      {notesOpen && (
        <NotesPanel
          notes={step.notes}
          pending={busy && notePending}
          onAdd={(text) => onAddNote(step, text)}
        />
      )}
    </li>
  );
}
