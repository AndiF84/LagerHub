// Ein abgeschlossener Durchlauf in der Historie (Tagesjournal), als Baum:
//  Ebene 1 – die Aufgabe (zugeklappt nur Name + Zusammenfassung; die Zeit ist
//            die Summe der Schritt-Dauern),
//  Ebene 2 – beim Aufklappen die Schritte mit ihrer Dauer, den beteiligten MA und deren
//            Einzelzeiten (Netto) sowie den (einklappbaren) Notizen.
// Wird im Dashboard ("heute erledigt") und im Statistik-Tab (Historie) genutzt.
import { useState } from "react";
import { useAddJournalNote } from "../api/queries";
import { formatMinutes } from "../lib/formatDuration";
import { NotesPanel } from "./NotesPanel";
import type { JournalEntry } from "../api/types";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

// Ein Schritt: MA mit Einzelzeiten; Notizen eingeklappt hinter dem 📝-Button.
function JournalStepRow({
  step,
  runId,
}: {
  step: JournalEntry["steps"][number];
  runId: string;
}) {
  const addNote = useAddJournalNote();
  const [notesOpen, setNotesOpen] = useState(false);
  const noteCount = step.notes?.length ?? 0;
  return (
    <div style={{ marginTop: 6, paddingLeft: 16 }}>
      <div className="row row--start" style={{ gap: 8, alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>{step.name}</strong>
        <span className="muted" style={{ fontSize: 13 }} title="Dauer des Schritts (ohne Unterbrechungen)">
          {formatMinutes(step.durationMinutes)}
        </span>
        <button
          className="btn"
          onClick={() => setNotesOpen((v) => !v)}
          aria-expanded={notesOpen}
          title="Notizen anzeigen/ausblenden"
        >
          📝 {noteCount > 0 ? noteCount : ""}
        </button>
      </div>
      {step.workers.length === 0 ? (
        <div className="muted" style={{ paddingLeft: 16, fontSize: 13 }}>
          keine Mitarbeiter erfasst
        </div>
      ) : (
        <ul style={{ margin: "2px 0 0", paddingLeft: 28, fontSize: 13 }}>
          {step.workers.map((w, i) => (
            <li key={w.employeeId || i} className="muted">
              {w.name} · {formatMinutes(w.activeMinutes)}
            </li>
          ))}
        </ul>
      )}
      {notesOpen && (
        <NotesPanel
          notes={step.notes}
          pending={addNote.isPending}
          onAdd={(text) =>
            addNote.mutate(
              { runId, stepId: step.id, text },
              { onError: (e) => alert(String(e)) },
            )
          }
        />
      )}
    </div>
  );
}

// Ein abgeschlossener Durchlauf, zuklappbar. Zu = nur die Aufgaben-Zeile;
// auf = die Schritte mit MA-Zeiten und Notizen.
export function JournalRunCard({ run }: { run: JournalEntry }) {
  const [open, setOpen] = useState(false);
  const participants = run.participants.join(", ");
  return (
    <div className="journal-run">
      {/* Feste Spalten (siehe .journal-run__head in styles.css), damit die
          Angaben über alle Durchläufe hinweg untereinander stehen. */}
      <div className="journal-run__head">
        <button
          className="btn"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? "Einklappen" : "Aufklappen"}
        >
          {open ? "▾" : "▸"}
        </button>
        <strong className="journal-run__task" title={run.taskName}>
          {run.taskName}
        </strong>
        <span className="muted journal-run__time">{formatTime(run.finishedAt)}</span>
        <span
          className="muted journal-run__duration"
          title="Gesamtzeit = Summe der Schritt-Dauern (ohne Liegezeit zwischen den Schritten)"
        >
          {formatMinutes(run.durationMinutes)}
        </span>
        <span className="muted journal-run__people" title={participants || undefined}>
          {participants || "–"}
        </span>
      </div>
      {open &&
        run.steps.map((s) => <JournalStepRow key={s.id} step={s} runId={run.id} />)}
    </div>
  );
}
