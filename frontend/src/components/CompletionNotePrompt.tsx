// Eingabe der Pflichtnotiz beim Schritt-Abschluss (Step.noteRequired).
// Erscheint erst beim Klick auf "Erledigt" und lässt sich nur mit gültigem Wert
// absenden. Die eigentliche Schranke ist der Backend-Guard in
// POST /assignments/:id/complete – das hier ist die bequeme Variante davon:
// der Fehler soll vor dem Absenden sichtbar sein, nicht als roter 400 danach.
import { useState } from "react";
import type { NoteFormat } from "../api/types";

// Spiegelt validateCompletionNote im Backend (services/notes.ts). Beide Seiten
// müssen dieselbe Zahl akzeptieren – deutsches Komma eingeschlossen, sonst wäre
// "42,5" hier gültig und dort nicht (oder umgekehrt).
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <label style={{ fontWeight: 600 }}>
        📝 {caption}
        {format === "NUMBER" && <span className="muted"> (Zahl)</span>}
      </label>
      <input
        autoFocus
        // inputMode statt type="number": Der Zahlen-Typ verschluckt in manchen
        // Browsern das Komma und liefert bei ungültiger Eingabe einen leeren
        // Wert – die Prüfung soll aber uns gehören, nicht dem Browser.
        inputMode={format === "NUMBER" ? "decimal" : "text"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder={format === "NUMBER" ? "z. B. 42" : "Angabe eingeben"}
        maxLength={2000}
        style={{ flex: 1, minWidth: 180 }}
      />
      <button className="btn btn--primary" onClick={submit} disabled={!valid || pending}>
        Abschließen
      </button>
      <button className="btn" onClick={onCancel} disabled={pending}>
        Abbrechen
      </button>
      {text.trim() !== "" && !valid && (
        <span className="muted">Bitte eine Zahl eingeben (Komma erlaubt).</span>
      )}
    </div>
  );
}
