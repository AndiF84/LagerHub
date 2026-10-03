import { randomUUID } from "node:crypto";

// Ein Notiz-Eintrag im Schritt-Verlauf (append-only). Gleiche Form live auf dem
// Step (Step.notes) wie eingefroren im Snapshot (TaskRun.data.steps[].notes).
// MA = Lager-MA (PWA); die übrigen sind Dashboard-Rollen. OFFICE/ADMIN gibt es
// erst seit die Notiz den echten Benutzernamen trägt – ältere Dashboard-Einträge
// stehen pauschal als MANAGER mit dem Namen „Manager“ im Verlauf.
export type NoteAuthorType = "MA" | "MANAGER" | "OFFICE" | "ADMIN";

// Autor eines Eintrags aus dem Token (req.user) – nie aus dem Body. Jede Rolle
// schreibt unter ihrem eigenen Namen, damit im Verlauf steht, WER etwas
// vermerkt hat (vorher stand bei allen Dashboard-Rollen nur „Manager“).
export function noteAuthorFromUser(user: { role: string; name: string }): {
  authorType: NoteAuthorType;
  authorName: string;
} {
  const authorType: NoteAuthorType =
    user.role === "WORKER"
      ? "MA"
      : user.role === "OFFICE" || user.role === "ADMIN"
        ? user.role
        : "MANAGER";
  return { authorType, authorName: user.name };
}

export interface NoteEntry {
  id: string;
  authorType: NoteAuthorType;
  authorName: string;
  text: string;
  at: string; // ISO-Zeitstempel
  // Pflichtnotiz beim Abschluss (Step.noteRequired) statt freier Notiz. Optional,
  // damit alle bereits gespeicherten Einträge unverändert gültig bleiben.
  kind?: "COMPLETION";
  // Nur bei Step.noteFormat = NUMBER: der geparste Wert. `text` behält die
  // Eingabeform für die Anzeige, `value` ist die rechenbare Zahl.
  value?: number;
  // Beschriftung des Feldes zum Zeitpunkt der Eingabe ("Anzahl Paletten").
  // Mitgespeichert, weil Step.noteLabel später geändert werden kann – der
  // Snapshot soll zeigen, wonach damals gefragt wurde.
  label?: string;
}

export function makeNoteEntry(
  text: string,
  authorType: NoteAuthorType,
  authorName: string,
): NoteEntry {
  return {
    id: randomUUID(),
    authorType,
    authorName,
    text: text.trim(),
    at: new Date().toISOString(),
  };
}

// Pflichtnotiz beim Schritt-Abschluss als Notiz-Eintrag.
export function makeCompletionNote(
  text: string,
  authorType: NoteAuthorType,
  authorName: string,
  label: string,
  value?: number,
): NoteEntry {
  return {
    ...makeNoteEntry(text, authorType, authorName),
    kind: "COMPLETION",
    ...(value !== undefined && { value }),
    ...(label.trim() !== "" && { label: label.trim() }),
  };
}

// Prüft die Pflichtnotiz gegen die am Schritt hinterlegte Form.
//   TEXT   -> nicht leer
//   NUMBER -> nicht leer und als Zahl lesbar (deutsches Komma erlaubt)
// Gibt bei Erfolg den bereinigten Text und – bei NUMBER – den Zahlwert zurück,
// sonst eine deutsche Fehlermeldung für die 400-Antwort.
export type NoteFormatName = "TEXT" | "NUMBER";

export type CompletionNoteResult =
  | { ok: true; text: string; value?: number }
  | { ok: false; error: string };

export function validateCompletionNote(
  raw: string | undefined,
  format: NoteFormatName,
  label: string,
): CompletionNoteResult {
  const what = label.trim() !== "" ? `„${label.trim()}"` : "Die Pflichtnotiz";
  const text = (raw ?? "").trim();
  if (text === "") return { ok: false, error: `${what} muss ausgefüllt werden.` };

  if (format === "NUMBER") {
    // Deutsches Komma zulassen; alles andere (Buchstaben, mehrere Trenner)
    // fällt über Number() auf NaN und wird abgewiesen.
    const value = Number(text.replace(",", "."));
    if (!Number.isFinite(value)) {
      return { ok: false, error: `${what} muss eine Zahl sein.` };
    }
    return { ok: true, text, value };
  }

  return { ok: true, text };
}

// Prisma liefert Json als unbekannten Wert – defensiv in ein NoteEntry[] parsen.
export function asNoteArray(value: unknown): NoteEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is NoteEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as NoteEntry).id === "string" &&
      typeof (e as NoteEntry).text === "string",
  );
}
