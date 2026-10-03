// Eingabe der Pflichtnotiz beim Schritt-Abschluss (PoolStep.noteRequired).
// Erscheint erst beim Tippen auf "Abschließen" und lässt sich nur mit gültigem
// Wert absenden. Die eigentliche Schranke ist der Backend-Guard in
// POST /assignments/:id/complete – das hier ist die bequeme Variante davon.
// Bewusst inline unter der Schritt-Zeile statt als Overlay: auf dem Handy
// verdeckt ein Modal die Zeile, um die es geht, und die Tastatur schiebt es weg.
import { useState } from "react";
import type { NoteFormat } from "../api/types";

// Spiegelt validateCompletionNote im Backend (services/notes.ts). Beide Seiten
// müssen dieselbe Zahl akzeptieren – deutsches Komma eingeschlossen.
export function isCompletionNoteValid(text: string, format: NoteFormat): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  if (format === "NUMBER") return Number.isFinite(Number(trimmed.replace(",", ".")));
  return true;
}

export function CompletionNotePrompt({
  label,
  format,
  pending,
  onSubmit,
  onCancel,
}: {
  label: string;
  format: NoteFormat;
  pending: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  const valid = isCompletionNoteValid(text, format);
  const caption = label.trim() !== "" ? label.trim() : "Pflichtnotiz";

  const submit = () => {
    if (valid && !pending) onSubmit(text.trim());
  };

  return (
    <div className="completion-note">
      <label className="completion-note__label" htmlFor="completion-note-input">
        📝 {caption}
        {format === "NUMBER" && <span className="muted"> (Zahl)</span>}
      </label>
      <input
        id="completion-note-input"
        autoFocus
        // inputMode statt type="number": blendet am Handy die Zifferntastatur
        // ein, ohne dass der Browser die Eingabe selbst verwirft (type="number"
        // liefert bei ungültigem Inhalt einen leeren Wert und verschluckt in
        // manchen Browsern das Komma).
        inputMode={format === "NUMBER" ? "decimal" : "text"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
        }}
        placeholder={format === "NUMBER" ? "z. B. 42" : "Angabe eingeben"}
        maxLength={2000}
      />
      {text.trim() !== "" && !valid && (
        <p className="muted completion-note__hint">Bitte eine Zahl eingeben (Komma erlaubt).</p>
      )}
      <div className="completion-note__actions">
        <button className="btn btn--primary" onClick={submit} disabled={!valid || pending}>
          Abschließen
        </button>
        <button className="btn" onClick={onCancel} disabled={pending}>
          Abbrechen
        </button>
      </div>
    </div>
  );
}
