// Notiz-Verlauf eines Schritts: Liste der Einträge (append-only) + Eingabe zum
// Anhängen. Wird im Dashboard (laufende Schritte) und in der Historie (Statistik)
// genutzt.
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
    <div style={{ padding: "6px 0" }}>
      {notes.length === 0 ? (
        <p className="muted" style={{ margin: "2px 0" }}>
          Noch keine Notizen.
        </p>
      ) : (
        <ul style={{ margin: "2px 0", paddingLeft: 18 }}>
          {notes.map((n) => (
            <li key={n.id} style={{ marginBottom: 2 }}>
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
      <div className="row" style={{ gap: 6, marginTop: 6, alignItems: "flex-start" }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Notiz hinzufügen (z. B. Probleme, Anzahl Reifen)… – Strg+Enter speichert"
          rows={2}
          style={{ flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
          }}
        />
        <button className="btn" onClick={submit} disabled={pending || !text.trim()}>
          Hinzufügen
        </button>
      </div>
    </div>
  );
}
