// MA-Detail-Auswertung (ein Mitarbeiter + Zeitraum), tabellarisch. Blöcke:
//   1 Kopf-KPIs · 2 je Schritttyp · 3 Einzelvorkommen (+ Notizen) · D Aufgaben ·
//   E+F Pro-Tag (inkl. inaktiver Zeit).
// Daten aus /stats/employee-detail (useEmployeeDetail). Reine Anzeige (8a) – das
// Setzen der Crewmeister-Zuordnung folgt separat (8b).
import { Fragment, useState } from "react";
import { useEmployeeDetail } from "../api/queries";
import type { EmployeeDetailOccurrence } from "../api/types";
import { NotesPanel } from "./NotesPanel";
import { exportEmployeeDetail } from "../lib/statsExport";
import { formatMinutes as fmtMin } from "../lib/formatDuration";
// "YYYY-MM-DD" → "DD.MM.YYYY"
const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

// Block 3: alle Einzelvorkommen eines Schritttyps, aufklappbar; je Vorkommen
// lässt sich der (eingefrorene) Notiz-Verlauf einblenden.
function StepOccurrences({ stepName, items }: { stepName: string; items: EmployeeDetailOccurrence[] }) {
  const [open, setOpen] = useState(false);
  const [openNotes, setOpenNotes] = useState<number | null>(null);
  return (
    <div className="card" style={{ marginTop: 6 }}>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ width: "100%", textAlign: "left", fontWeight: 600 }}
      >
        {open ? "▾" : "▸"} {stepName} <span className="muted">· {items.length}×</span>
      </button>
      {open && (
        <table style={{ marginTop: 8 }}>
          <thead>
            <tr>
              <th>Datum</th>
              <th>Aufgabe</th>
              <th>Netto</th>
              <th>Wechsel</th>
              <th>Notizen</th>
            </tr>
          </thead>
          <tbody>
            {items.map((o, i) => (
              <Fragment key={`${o.runId}-${o.stepName}-${i}`}>
                <tr>
                  <td>{fmtDate(o.date)}</td>
                  <td>{o.taskName}</td>
                  <td>{fmtMin(o.activeMinutes)}</td>
                  <td>{o.switchCount > 0 ? o.switchCount : "–"}</td>
                  <td>
                    {o.notes.length > 0 ? (
                      <button className="btn" onClick={() => setOpenNotes(openNotes === i ? null : i)}>
                        📝 {o.notes.length}
                      </button>
                    ) : (
                      <span className="muted">–</span>
                    )}
                  </td>
                </tr>
                {openNotes === i && o.notes.length > 0 && (
                  <tr>
                    <td colSpan={5}>
                      {/* Reine Anzeige: onAdd ist hier no-op (Nachtragen läuft über die Historie). */}
                      <NotesPanel notes={o.notes} onAdd={() => {}} pending />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function EmployeeDetailSection({
  employeeId,
  from,
  to,
}: {
  employeeId: string;
  from: string;
  to: string;
}) {
  const { data, isLoading } = useEmployeeDetail(employeeId, from, to);

  if (isLoading) return <p className="muted">Lade Auswertung…</p>;
  if (!data) return <p className="muted">Keine Daten.</p>;

  const { totals, byStep, occurrences, byTask, perDay, crewmeister } = data;

  if (totals.stepCount === 0) {
    return <p className="muted">Keine Schritte im gewählten Zeitraum.</p>;
  }

  // Block 3: Einzelvorkommen nach Schritttyp gruppieren (Reihenfolge wie byStep).
  const occByStep = new Map<string, EmployeeDetailOccurrence[]>();
  for (const o of occurrences) {
    const arr = occByStep.get(o.stepName) ?? [];
    arr.push(o);
    occByStep.set(o.stepName, arr);
  }

  // Inaktive Zeit nur zeigen, wenn echte Arbeitszeit vorliegt; sonst Grund nennen.
  const inactiveLabel = crewmeister.available ? fmtMin(totals.inactiveMinutes) : "–";

  return (
    <div>
      {/* Links ausgerichtet wie der Export der "Alle"-Ansicht (AnalyticsSection):
          der Button behält beim Wechsel der MA-Auswahl seinen Platz. */}
      <div className="row row--start" style={{ marginBottom: 8 }}>
        <button
          className="btn btn--excel"
          onClick={() => exportEmployeeDetail(data)}
          title="Kopf-Kennzahlen, je Schritttyp, Einzelvorkommen, Aufgaben-Verteilung und Pro-Tag in einer Excel-Mappe"
        >
          ⬇ Excel: MA-Detail
        </button>
      </div>

      {/* Block 1 – Kopf-KPIs */}
      <div className="kpis">
        <div className="kpi">
          <div className="kpi__value">{fmtMin(totals.activeMinutes)}</div>
          <div className="kpi__label">Aktive Zeit</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{totals.switchCount}</div>
          <div className="kpi__label">Wechsel (Anzahl)</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{inactiveLabel}</div>
          <div className="kpi__label">Inaktiv (nicht eingeloggt)</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{totals.stepCount}</div>
          <div className="kpi__label">Schritte</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{totals.runCount}</div>
          <div className="kpi__label">Durchläufe</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{totals.stepTypeCount}</div>
          <div className="kpi__label">Schritttypen</div>
        </div>
      </div>
      {!crewmeister.available && (
        <p className="muted" style={{ marginTop: 4 }}>
          Inaktive Zeit nicht verfügbar: {crewmeister.reason ?? "keine Arbeitszeitdaten"}.
        </p>
      )}

      {/* Block 2 – je Schritttyp */}
      <h3 style={{ fontSize: 14, margin: "16px 0 4px" }}>Je Schritttyp</h3>
      <table>
        <thead>
          <tr>
            <th>Schritt</th>
            <th>Anzahl</th>
            <th>Summe Netto</th>
            <th>Ø Netto</th>
            <th>Ø Wechsel</th>
            <th>Kürzeste</th>
            <th>Längste</th>
          </tr>
        </thead>
        <tbody>
          {byStep.map((s) => (
            <tr key={s.stepName}>
              <td>{s.stepName}</td>
              <td>{s.count}</td>
              <td>{fmtMin(s.totalActiveMinutes)}</td>
              <td>{fmtMin(s.avgActiveMinutes)}</td>
              <td>{s.avgSwitchCount > 0 ? s.avgSwitchCount : "–"}</td>
              <td>{fmtMin(s.minActiveMinutes)}</td>
              <td>{fmtMin(s.maxActiveMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Block 3 – Einzelvorkommen je Schritttyp */}
      <h3 style={{ fontSize: 14, margin: "16px 0 4px" }}>Einzelvorkommen</h3>
      {byStep.map((s) => (
        <StepOccurrences key={s.stepName} stepName={s.stepName} items={occByStep.get(s.stepName) ?? []} />
      ))}

      {/* Block D – Aufgaben-Verteilung */}
      <h3 style={{ fontSize: 14, margin: "16px 0 4px" }}>Aufgaben-Verteilung</h3>
      <table>
        <thead>
          <tr>
            <th>Aufgabe</th>
            <th>Anzahl</th>
            <th>Aktive Zeit</th>
            <th>Anteil</th>
          </tr>
        </thead>
        <tbody>
          {byTask.map((t) => (
            <tr key={t.taskName}>
              <td>{t.taskName}</td>
              <td>{t.count}</td>
              <td>{fmtMin(t.activeMinutes)}</td>
              <td>{t.sharePercent} %</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Block E+F – Pro Tag */}
      <h3 style={{ fontSize: 14, margin: "16px 0 4px" }}>Pro Tag</h3>
      <table>
        <thead>
          <tr>
            <th>Datum</th>
            <th>Schritte</th>
            <th>Aktive Zeit</th>
            <th>Inaktiv</th>
          </tr>
        </thead>
        <tbody>
          {perDay.map((d) => (
            <tr key={d.date}>
              <td>{fmtDate(d.date)}</td>
              <td>{d.stepCount}</td>
              <td>{fmtMin(d.activeMinutes)}</td>
              <td>{fmtMin(d.inactiveMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
