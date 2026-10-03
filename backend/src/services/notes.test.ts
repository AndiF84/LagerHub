import { describe, expect, it } from "vitest";

import {
  noteAuthorFromUser,
  asNoteArray,
  makeCompletionNote,
  makeNoteEntry,
  validateCompletionNote,
} from "./notes.js";

// Der Notiz-Verlauf ist append-only und wird an drei Stellen gelesen, an denen
// Prisma nur `unknown` liefert (Step.notes, TaskRun.data, Historie-Nachtrag).
// `asNoteArray` ist die einzige Schranke dagegen, dass ein alter oder kaputter
// JSON-Wert als Notiz-Liste durchgereicht wird und die Anzeige zerlegt.
describe("asNoteArray", () => {
  it("gibt einen gültigen Verlauf unverändert zurück", () => {
    const notes = [
      { id: "a", authorType: "MA", authorName: "Nina", text: "Palette fehlt", at: "2026-08-23T08:00:00.000Z" },
      { id: "b", authorType: "MANAGER", authorName: "Chef", text: "Nachbestellt", at: "2026-08-23T08:05:00.000Z" },
    ];

    expect(asNoteArray(notes)).toEqual(notes);
  });

  // Der Normalfall für einen Schritt, an dem noch niemand etwas notiert hat.
  it("liefert eine leere Liste für einen leeren Verlauf", () => {
    expect(asNoteArray([])).toEqual([]);
  });

  // Prisma-Json kann alles sein: null (Spalte nie beschrieben), ein Objekt aus
  // einer früheren Form, ein Skalar. Keiner dieser Fälle darf werfen.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["ein Objekt", { id: "a", text: "x" }],
    ["ein String", "keine Liste"],
    ["eine Zahl", 42],
  ])("liefert eine leere Liste für %s", (_fall, value) => {
    expect(asNoteArray(value)).toEqual([]);
  });

  // Einzelne kaputte Einträge werden verworfen, die übrigen bleiben – ein
  // beschädigter Eintrag darf nicht den ganzen Verlauf eines Laufs auslöschen.
  it("filtert unvollständige Einträge heraus und behält die übrigen", () => {
    const gut = { id: "gut", authorType: "MA", authorName: "Nina", text: "ok", at: "2026-08-23T08:00:00.000Z" };

    const result = asNoteArray([
      gut,
      { authorName: "ohne id", text: "x" },
      { id: "ohne-text", authorName: "Nina" },
      null,
      "kein Objekt",
      { id: 1, text: "id ist keine Zeichenkette" },
    ]);

    expect(result).toEqual([gut]);
  });
});

describe("makeNoteEntry", () => {
  it("übernimmt Autor und Text und vergibt id + Zeitstempel", () => {
    const entry = makeNoteEntry("Karton beschädigt", "MA", "Nina");

    expect(entry.authorType).toBe("MA");
    expect(entry.authorName).toBe("Nina");
    expect(entry.text).toBe("Karton beschädigt");
    expect(entry.id).toBeTruthy();
    // ISO-Form: so liest die Anzeige den Zeitstempel wieder ein.
    expect(new Date(entry.at).toISOString()).toBe(entry.at);
  });

  // Getrimmt wird beim Anlegen, nicht beim Anzeigen: der Verlauf ist die
  // gespeicherte Wahrheit, und führende Leerzeichen aus einem Handy-Tastenfeld
  // sollen dort nicht landen.
  it("trimmt den Text", () => {
    expect(makeNoteEntry("  mit Rand  ", "MANAGER", "Chef").text).toBe("mit Rand");
  });

  it("vergibt für jeden Eintrag eine eigene id", () => {
    const a = makeNoteEntry("eins", "MA", "Nina");
    const b = makeNoteEntry("zwei", "MA", "Nina");

    expect(a.id).not.toBe(b.id);
  });

  // Der Eintrag muss die Schranke von asNoteArray passieren – sonst würde eine
  // gerade geschriebene Notiz beim nächsten Lesen wieder verschwinden.
  it("erzeugt einen Eintrag, den asNoteArray akzeptiert", () => {
    const entry = makeNoteEntry("Palette fehlt", "MA", "Nina");

    expect(asNoteArray([entry])).toEqual([entry]);
  });
});

// Pflichtnotiz beim Schritt-Abschluss (Step.noteRequired). Der Wert ist die
// einzige Bedingung, die einen Abschluss verhindern kann, ohne dass etwas am
// Zustand des Schritts falsch wäre – deshalb muss die Prüfung eindeutig sein.
describe("validateCompletionNote", () => {
  it("nimmt Freitext an", () => {
    expect(validateCompletionNote("Charge B12 verbaut", "TEXT", "")).toEqual({
      ok: true,
      text: "Charge B12 verbaut",
    });
  });

  // Ohne Trimmen käme ein versehentliches Leerzeichen als gültige Angabe durch.
  it.each([
    ["leer", ""],
    ["nur Leerzeichen", "   "],
    ["fehlend", undefined],
  ])("weist eine %s Angabe ab", (_name, raw) => {
    const result = validateCompletionNote(raw as string | undefined, "TEXT", "");

    expect(result.ok).toBe(false);
  });

  // Die Beschriftung wandert in die Fehlermeldung, damit der MA am Handy sieht,
  // WAS fehlt – "Pflichtnotiz fehlt" allein hilft bei drei Feldern nicht.
  it("nennt die Beschriftung in der Fehlermeldung", () => {
    const result = validateCompletionNote("", "NUMBER", "Anzahl Paletten");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Anzahl Paletten");
  });

  it("fällt ohne Beschriftung auf eine allgemeine Meldung zurück", () => {
    const result = validateCompletionNote("", "TEXT", "");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Pflichtnotiz");
  });

  // Auf dem deutschen Ziffernblock ist das Komma das Trennzeichen – ohne diese
  // Umsetzung wäre "42,5" keine Zahl und der Abschluss unmöglich.
  it.each([
    ["ganze Zahl", "42", 42],
    ["deutsches Komma", "42,5", 42.5],
    ["Punkt", "42.5", 42.5],
    ["mit Rand", "  7  ", 7],
    ["Null", "0", 0],
  ])("liest eine Zahl als %s", (_name, raw, expected) => {
    const result = validateCompletionNote(raw as string, "NUMBER", "Menge");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(expected);
  });

  it.each([
    ["Buchstaben", "zwölf"],
    ["Zahl mit Einheit", "42 Stück"],
    ["zwei Trenner", "1,2,3"],
    ["nur ein Komma", ","],
  ])("weist %s als Zahl ab", (_name, raw) => {
    const result = validateCompletionNote(raw as string, "NUMBER", "Menge");

    expect(result.ok).toBe(false);
  });

  // NaN wäre der einzige Weg, wie eine ungültige Zahl in value landen könnte.
  it("gibt bei Freitext keinen Zahlwert zurück", () => {
    const result = validateCompletionNote("42", "TEXT", "");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeUndefined();
  });
});

describe("makeCompletionNote", () => {
  // Wie bei makeNoteEntry: was asNoteArray nicht akzeptiert, verschwindet beim
  // nächsten Lesen wieder – hier wäre das die Pflichtnotiz selbst.
  it("erzeugt einen Eintrag, den asNoteArray akzeptiert", () => {
    const entry = makeCompletionNote("42", "MA", "Nina", "Anzahl Paletten", 42);

    expect(asNoteArray([entry])).toEqual([entry]);
  });

  it("markiert den Eintrag als Abschluss-Angabe", () => {
    const entry = makeCompletionNote("42", "MA", "Nina", "Anzahl Paletten", 42);

    expect(entry.kind).toBe("COMPLETION");
    expect(entry.value).toBe(42);
    expect(entry.label).toBe("Anzahl Paletten");
  });

  // Ohne Zahlwert (Freitext) und ohne Beschriftung sollen die Felder gar nicht
  // erst im JSON stehen, statt als undefined/leer mitgeschleppt zu werden.
  it("lässt Zahlwert und Beschriftung weg, wenn es keine gibt", () => {
    const entry = makeCompletionNote("Charge B12", "MANAGER", "Chef", "");

    expect(entry).not.toHaveProperty("value");
    expect(entry).not.toHaveProperty("label");
  });
});

describe("noteAuthorFromUser – wer steht am Notiz-Eintrag", () => {
  it("jede Rolle schreibt unter ihrem eigenen Namen (nicht pauschal „Manager“)", () => {
    expect(noteAuthorFromUser({ role: "WORKER", name: "Nina" })).toEqual({ authorType: "MA", authorName: "Nina" });
    expect(noteAuthorFromUser({ role: "MANAGER", name: "Petra" })).toEqual({ authorType: "MANAGER", authorName: "Petra" });
    expect(noteAuthorFromUser({ role: "OFFICE", name: "Jens" })).toEqual({ authorType: "OFFICE", authorName: "Jens" });
    expect(noteAuthorFromUser({ role: "ADMIN", name: "Chef" })).toEqual({ authorType: "ADMIN", authorName: "Chef" });
  });

  it("Einträge mit neuen Rollen passieren die asNoteArray-Schranke", () => {
    const entry = makeNoteEntry("Rampe 3 frei", "OFFICE", "Jens");
    expect(asNoteArray([entry])).toEqual([entry]);
  });
});
