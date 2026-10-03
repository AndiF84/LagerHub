// Notiz-Verlauf eines Schritts in der PWA (M3): append-only Liste + Eingabe zum
// Anhängen eines MA-Eintrags. Mobil gehalten (große Touch-Fläche); spiegelt
// bewusst das NotesPanel des Manager-Dashboards inhaltlich.
import { useState } from "react";
import type { NoteEntry } from "../api/types";

// Rolle hinter dem Namen. Ältere Dashboard-Einträge tragen pauschal MANAGER mit
// dem Namen „Manager“ – die werden unverändert so angezeigt wie bisher.
const AUTHOR_LABEL: Record<NoteEntry["authorType"], string> = {
  MA: "MA",
  MANAGER: "Manager",
  OFFICE: "Büro",
  ADMIN: "Admin",
};

function formatStamp(iso: string): string {
  return new Date(iso).toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function NotesPanel({
  notes,
  onAdd,
  pending,
}: {
  notes: NoteEntry[];
  onAdd: (text: string) => void;
  pending?: boolean;
}) {
  const [text, setText] = useState("");

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText("");
  };

  return (
    <div className="notes">
      {notes.length === 0 ? (
        <p className="muted notes__empty">Noch keine Notizen.</p>
      ) : (
        <ul className="notes__list">
          {notes.map((n) => (
            <li key={n.id}>
              <span className="muted">
                {formatStamp(n.at)} · {n.authorName} ({AUTHOR_LABEL[n.authorType] ?? "Manager"}):
              </span>{" "}
              {/* Pflichtnotiz beim Abschluss hervorheben: sie ist eine Messung,
                  keine Bemerkung – zwischen Freitext-Notizen ginge sie unter. */}
              {n.kind === "COMPLETION" ? (
                <strong>
                  {n.label ? `${n.label}: ` : ""}
                  {n.text}
                </strong>
              ) : (
                n.text
              )}
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="notes__input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Notiz hinzufügen (z. B. Problem, Anzahl)…"
        rows={2}
      />
      <button className="btn btn--block" onClick={submit} disabled={pending || !text.trim()}>
        {pending ? "Speichert…" : "Notiz hinzufügen"}
      </button>
    </div>
  );
}
