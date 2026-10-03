// Excel-Export der einzelnen Statistiken (echtes .xlsx via SheetJS/xlsx).
// Läuft komplett im Frontend aus den bereits geladenen Query-Daten – kein
// Backend-Endpoint nötig. Die Werte behalten ihren JS-Typ (Zahlen bleiben
// Zahlen), damit Excel direkt damit rechnen kann. Deutsche Objekt-Schlüssel
// werden zu Spaltenüberschriften.
import * as XLSX from "xlsx";
import type {
  AvgByTask,
  EmployeeDetail,
  EmployeeHistoryRow,
  EmployeeLoad,
  StatsSummary,
  StepDuration,
  TasksByStatus,
  ThroughputDay,
  ThroughputResult,
} from "../api/types";

// Dateinamens-Zeitstempel: bei Zeitraum „von_bis", sonst das heutige Datum.
function stamp(from?: string, to?: string): string {
  if (from && to) return from === to ? from : `${from}_bis_${to}`;
  return new Date().toISOString().slice(0, 10);
}

// Ein Blatt aus Zeilen-Objekten als .xlsx herunterladen.
function saveSheet(rows: Record<string, unknown>[], sheetName: string, fileName: string) {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  XLSX.writeFile(wb, fileName);
}

// --- Statistik-Tab: Tagesübersicht (KPIs + Aufgaben nach Status) ------------
export function exportSummary(summary: StatsSummary, byStatus: TasksByStatus) {
  const rows = [
    { Kennzahl: "Schritte erledigt (heute)", Wert: summary.stepsCompletedToday },
    { Kennzahl: "Aktive Mitarbeiter", Wert: summary.activeEmployees },
    { Kennzahl: "Offene Pool-Aufgaben", Wert: summary.poolTasksOpen },
    { Kennzahl: "Ø Durchlaufzeit heute (min)", Wert: summary.avgDurationMinutes ?? "" },
    { Kennzahl: "Aufgaben offen", Wert: byStatus.open },
    { Kennzahl: "Aufgaben laufend", Wert: byStatus.running },
    { Kennzahl: "Aufgaben abgeschlossen (heute)", Wert: byStatus.completed },
  ];
  saveSheet(rows, "Tagesübersicht", `Tagesuebersicht_${stamp()}.xlsx`);
}

// --- Statistik-Tab: Mitarbeiter-Auslastung (heute) --------------------------
export function exportEmployeeLoad(load: EmployeeLoad[], now: number) {
  const rows = load.map((l) => {
    const currentSec =
      l.currentSince != null
        ? Math.max(0, Math.floor((now - new Date(l.currentSince).getTime()) / 1000))
        : 0;
    const totalSec = Math.floor(l.activeBaseMs / 1000) + currentSec;
    return {
      Mitarbeiter: l.name,
      "Aktuelle Aufgabe": l.currentTask ?? "",
      "Aktueller Schritt": l.currentStep ?? "",
      "Zeit aktuell (min)": l.currentSince != null ? Math.round(currentSec / 60) : "",
      "Aktive Zeit heute (min)": Math.round(totalSec / 60),
    };
  });
  saveSheet(rows, "Auslastung", `Auslastung_heute_${stamp()}.xlsx`);
}

// --- Auswertung (Zeitraum): alles in EINER Mappe (Filter „Alle") -----------
// Zeilen-Mapper je Datensatz, dienen den Blättern der kombinierten Mappe.
function employeeHistoryRows(rows: EmployeeHistoryRow[]) {
  return rows.map((r) => ({
    Mitarbeiter: r.name,
    "Aktive Minuten": r.activeMinutes,
    Schritte: r.stepCount,
    Aufgaben: r.taskCount,
    "Ø Minuten / Schritt": r.avgStepMinutes,
  }));
}
function throughputPerDayRows(rows: ThroughputDay[]) {
  return rows.map((r) => ({
    Tag: r.day,
    Läufe: r.runCount,
    "Ø Dauer (min)": r.avgMinutes,
  }));
}
function throughputByTaskRows(rows: AvgByTask[]) {
  return rows.map((r) => ({
    Aufgabentyp: r.taskName,
    Läufe: r.runCount,
    "Ø Dauer (min)": r.avgMinutes,
  }));
}
function stepDurationRows(rows: StepDuration[]) {
  return rows.map((r) => ({
    Aufgabe: r.taskName,
    Schritt: r.stepName,
    "Ø Minuten": r.avgMinutes,
    Vorkommen: r.count,
    "Min (min)": r.minMinutes,
    "Max (min)": r.maxMinutes,
  }));
}

// Gesamtansicht „Alle": MA-Auswertung + Ø je Arbeitsschritt + Durchsatz pro Tag
// + Ø je Aufgabentyp als EIN .xlsx, übernimmt den gewählten Zeitraum.
export function exportAnalyticsRange(
  emp: EmployeeHistoryRow[],
  tp: ThroughputResult | undefined,
  steps: StepDuration[],
  from: string,
  to: string,
) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(employeeHistoryRows(emp)), "MA-Auswertung");
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(stepDurationRows(steps)),
    "Ø je Arbeitsschritt",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(throughputPerDayRows(tp?.perDay ?? [])),
    "Durchsatz pro Tag",
  );
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(throughputByTaskRows(tp?.avgByTask ?? [])),
    "Ø je Aufgabentyp",
  );
  XLSX.writeFile(wb, `Auswertung_${stamp(from, to)}.xlsx`);
}

// --- MA-Detailansicht: eine Arbeitsmappe mit mehreren Blättern --------------
export function exportEmployeeDetail(detail: EmployeeDetail) {
  const { name, from, to, totals, byStep, byTask, perDay, occurrences } = detail;

  const overview = [
    { Kennzahl: "Aktive Zeit (min)", Wert: totals.activeMinutes },
    { Kennzahl: "Wechsel (Anzahl)", Wert: totals.switchCount },
    { Kennzahl: "Inaktiv (min)", Wert: totals.inactiveMinutes ?? "" },
    { Kennzahl: "Schritte", Wert: totals.stepCount },
    { Kennzahl: "Durchläufe", Wert: totals.runCount },
    { Kennzahl: "Schritttypen", Wert: totals.stepTypeCount },
  ];
  const stepRows = byStep.map((s) => ({
    Schritt: s.stepName,
    Anzahl: s.count,
    "Summe Netto (min)": s.totalActiveMinutes,
    "Ø Netto (min)": s.avgActiveMinutes,
    "Ø Wechsel (Anzahl)": s.avgSwitchCount,
    "Kürzeste (min)": s.minActiveMinutes,
    "Längste (min)": s.maxActiveMinutes,
  }));
  const taskRows = byTask.map((t) => ({
    Aufgabe: t.taskName,
    Anzahl: t.count,
    "Aktive Zeit (min)": t.activeMinutes,
    "Anteil (%)": t.sharePercent,
  }));
  const dayRows = perDay.map((d) => ({
    Datum: d.date,
    Schritte: d.stepCount,
    "Aktive Zeit (min)": d.activeMinutes,
    "Inaktiv (min)": d.inactiveMinutes ?? "",
  }));
  const occRows = occurrences.map((o) => ({
    Datum: o.date,
    Schritt: o.stepName,
    Aufgabe: o.taskName,
    "Netto (min)": o.activeMinutes,
    "Wechsel (Anzahl)": o.switchCount,
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(overview), "Übersicht");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stepRows), "Je Schritttyp");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(taskRows), "Aufgaben");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(dayRows), "Pro Tag");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(occRows), "Einzelvorkommen");
  XLSX.writeFile(wb, `MA-Detail_${name}_${stamp(from, to)}.xlsx`);
}
