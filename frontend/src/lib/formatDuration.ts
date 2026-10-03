// Anzeige von Zeitspannen im Dashboard.
//
// Grundsatz: gerechnet und übertragen wird durchgehend in GANZEN MINUTEN – so
// liefert das Backend (/stats rundet alle Werte auf Minuten) und so landen sie
// auch im Excel-Export (lib/statsExport.ts schreibt blanke Zahlen mit "(min)"
// in der Spaltenüberschrift, damit man in Excel damit rechnen kann).
// NUR die Anzeige formt in Stunden + Minuten um: "1 h 16 min" lässt sich
// schneller greifen als "76 min".
//
// Diese Funktion ist die einzige Stelle für dieses Format – sie stand vorher
// zweimal wortgleich im Code (JournalRunCard, EmployeeDetailSection).

/** Minuten → "45 min", "1 h 16 min", "2 h" (glatte Stunde), "–" für null. */
export function formatMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return "–";
  const total = Math.round(min);
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  // Glatte Stunde ohne "00 min"; sonst Minuten zweistellig, damit "2 h 05 min"
  // und "2 h 45 min" untereinander gleich breit bleiben.
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
}
