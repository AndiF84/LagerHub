// Historie/Auswertung im Statistik-Tab: Zeitraum-Auswahl + Diagramme (Recharts)
// über aktive Zeit & übernommene Schritte je MA, Durchsatz pro Tag und Ø Dauer
// je Aufgabentyp. Daten aus /stats/employee-history (WorkLog) und
// /stats/throughput (TaskRun). Default-Zeitraum: letzte 7 Tage.
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useEmployeeHistory, useEmployees, useStepDurations, useThroughput } from "../api/queries";
import { EmployeeDetailSection } from "./EmployeeDetailSection";
import { exportAnalyticsRange } from "../lib/statsExport";
import { CHART_AXIS, CHART_COLORS, CHART_GRID } from "../lib/chartColors";
import { formatMinutes } from "../lib/formatDuration";

// Diagramm-Tooltip: Minutenwerte als "1 h 16 min" (die Achse bleibt in
// Minuten – als Skala ist eine durchgehende Einheit lesbarer).
// (unknown: Recharts reicht hier ValueType durch – auch undefined/Array;
// formatMinutes fängt alles Nicht-Endliche mit "–" ab.)
const minutesTooltip = (v: unknown) => formatMinutes(Number(v));

// Gemeinsame Achsen-/Gitter-Einstellungen: Gitter nur waagerecht, Achslinien
// zurückgenommen – die Daten sollen das Kräftigste im Bild sein.
const gridProps = { stroke: CHART_GRID, vertical: false } as const;
const axisTick = { fontSize: 12, fill: CHART_AXIS } as const;

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const todayKey = () => dateKey(new Date());
const daysAgoKey = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return dateKey(d);
};
// Ein Diagramm, standardmäßig eingeklappt; öffnet auf Klick auf die Kopfzeile.
function CollapsibleChart({ title, children }: { title: string; children: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card" style={{ marginTop: 8 }}>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Einklappen" : "Aufklappen"}
        style={{ width: "100%", textAlign: "left", fontWeight: 600 }}
      >
        {open ? "▾" : "▸"} {title}
      </button>
      {open && (
        <div style={{ width: "100%", height: 260, marginTop: 8 }}>
          <ResponsiveContainer>{children}</ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Ø Netto-Zeit je Arbeitsschritt über den Zeitraum, gruppiert nach (Aufgabe,
// Schritt). Dropdown filtert auf eine Aufgabe (Default "Alle"), damit die Liste
// übersichtlich bleibt; darunter ein Balkendiagramm für die aktuelle Auswahl.
function StepDurationsSection({ from, to }: { from: string; to: string }) {
  const { data } = useStepDurations(from, to);
  const [task, setTask] = useState(""); // "" = alle Aufgaben
  const [open, setOpen] = useState(false); // kosmetisch eingeklappt (große Tabelle)

  const steps = data?.steps ?? [];
  // Aufgaben für das Dropdown (eindeutig, in Anzeigereihenfolge der Daten).
  const tasks = Array.from(new Set(steps.map((s) => s.taskName)));
  // Bei Auswahl auf eine Aufgabe einschränken; sonst nach Ø-Zeit absteigend, damit
  // die langwierigsten Schritte über alle Aufgaben oben stehen.
  const rows = task
    ? steps.filter((s) => s.taskName === task)
    : [...steps].sort((a, b) => b.avgMinutes - a.avgMinutes);
  // Für das Diagramm eindeutige, kompakte Labels.
  const chartData = rows.map((s) => ({ ...s, label: task ? s.stepName : `${s.stepName} · ${s.taskName}` }));

  return (
    <div style={{ marginTop: 16 }}>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Einklappen" : "Aufklappen"}
        style={{ width: "100%", textAlign: "left", fontWeight: 600 }}
      >
        {open ? "▾" : "▸"} Ø Zeit je Arbeitsschritt
      </button>
      {open && (
      <div style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <label className="muted">
          Aufgabe{" "}
          <select value={task} onChange={(e) => setTask(e.target.value)}>
            <option value="">Alle Aufgaben</option>
            {tasks.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      </div>
      {rows.length > 0 ? (
        <>
          <table>
            <thead>
              <tr>
                {!task && <th>Aufgabe</th>}
                <th>Schritt</th>
                <th>Ø Zeit</th>
                <th>Vorkommen</th>
                <th>Kürzeste</th>
                <th>Längste</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={`${s.taskName}·${s.stepName}`}>
                  {!task && <td>{s.taskName}</td>}
                  <td>{s.stepName}</td>
                  <td>{formatMinutes(s.avgMinutes)}</td>
                  <td>{s.count}</td>
                  <td>{formatMinutes(s.minMinutes)}</td>
                  <td>{formatMinutes(s.maxMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <CollapsibleChart title="Ø Zeit je Arbeitsschritt (Minuten)">
            <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 8 }}>
              <CartesianGrid stroke={CHART_GRID} horizontal={false} />
              <XAxis type="number" tick={axisTick} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
              <YAxis
                type="category"
                dataKey="label"
                tick={axisTick}
                tickLine={false}
                axisLine={false}
                width={160}
              />
              <Tooltip formatter={minutesTooltip} />
              <Bar dataKey="avgMinutes" name="Ø Zeit" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} maxBarSize={22} />
            </BarChart>
          </CollapsibleChart>
        </>
      ) : (
        <p className="muted">Keine abgeschlossenen Schritte im gewählten Zeitraum.</p>
      )}
      </div>
      )}
    </div>
  );
}

export function AnalyticsSection() {
  const today = todayKey();
  const initialFrom = daysAgoKey(6); // letzte 7 Tage (heute + 6 Vortage)
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(today);
  const [applied, setApplied] = useState({ from: initialFrom, to: today });
  // "" = Alle (bestehende Diagramme); sonst die MA-Detailansicht.
  const [employeeId, setEmployeeId] = useState("");

  const { data: employees } = useEmployees();
  const { data: emp } = useEmployeeHistory(applied.from, applied.to);
  const { data: tp } = useThroughput(applied.from, applied.to);
  // Auch hier laden (gleicher Query-Key wie in StepDurationsSection → aus dem
  // Cache, kein zweiter Request), damit der Excel-Export die Schritte mitnimmt.
  const { data: stepDur } = useStepDurations(applied.from, applied.to);

  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 24 }}>Auswertung (Zeitraum)</h2>
      <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <label className="muted">
          Mitarbeiter{" "}
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">Alle</option>
            {employees?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="muted">
          Von{" "}
          <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="muted">
          Bis{" "}
          <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button
          className="btn"
          disabled={!from || !to}
          onClick={() => setApplied({ from, to })}
        >
          Suchen
        </button>
        <span className="muted">
          {applied.from === applied.to ? applied.from : `${applied.from} – ${applied.to}`}
        </span>
      </div>

      {/* Ein MA gewählt → tabellarische Detailansicht; sonst die Gesamt-Diagramme. */}
      {employeeId ? (
        <EmployeeDetailSection employeeId={employeeId} from={applied.from} to={applied.to} />
      ) : (
        <>
      <div className="row row--start" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap", alignItems: "center" }}>
        {/* Der Zeitraum steckt im Tooltip und im Dateinamen, nicht in der
            Beschriftung – sonst wechselt der Button mit jedem Filter die Breite. */}
        <button
          className="btn btn--excel"
          disabled={!emp?.length && !stepDur?.steps.length && !tp?.perDay.length && !tp?.avgByTask.length}
          onClick={() => exportAnalyticsRange(emp ?? [], tp, stepDur?.steps ?? [], applied.from, applied.to)}
          title={`MA-Auswertung, Ø je Arbeitsschritt, Durchsatz pro Tag und Ø je Aufgabentyp in einer Excel-Mappe (${
            applied.from === applied.to ? applied.from : `${applied.from} – ${applied.to}`
          })`}
        >
          ⬇ Excel: Auswertung
        </button>
      </div>
      {emp && emp.length > 0 ? (
        <table>
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Aktive Zeit</th>
              <th>Schritte</th>
              <th>Aufgaben</th>
              <th>Ø je Schritt</th>
            </tr>
          </thead>
          <tbody>
            {emp.map((r) => (
              <tr key={r.employeeId}>
                <td>{r.name}</td>
                <td>{formatMinutes(r.activeMinutes)}</td>
                <td>{r.stepCount}</td>
                <td>{r.taskCount}</td>
                <td>{formatMinutes(r.avgStepMinutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">Keine Aktivität im gewählten Zeitraum.</p>
      )}

      <StepDurationsSection from={applied.from} to={applied.to} />

      <h3 style={{ fontSize: 14, margin: "16px 0 0" }}>Diagramme</h3>

      <CollapsibleChart title="Aktive Zeit je Mitarbeiter (Minuten)">
        <BarChart data={emp ?? []}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" tick={axisTick} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={44} />
          <Tooltip formatter={minutesTooltip} />
          <Bar
            dataKey="activeMinutes"
            name="Aktive Zeit"
            fill={CHART_COLORS[0]}
            radius={[4, 4, 0, 0]}
            maxBarSize={48}
          />
        </BarChart>
      </CollapsibleChart>

      <CollapsibleChart title="Übernommene Schritte je Mitarbeiter">
        <BarChart data={emp ?? []}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="name" tick={axisTick} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
          <YAxis allowDecimals={false} tick={axisTick} tickLine={false} axisLine={false} width={44} />
          <Tooltip />
          <Bar
            dataKey="stepCount"
            name="Schritte"
            fill={CHART_COLORS[0]}
            radius={[4, 4, 0, 0]}
            maxBarSize={48}
          />
        </BarChart>
      </CollapsibleChart>

      <CollapsibleChart title="Ø Dauer je Aufgabentyp (Minuten)">
        <BarChart data={tp?.avgByTask ?? []}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="taskName" tick={axisTick} tickLine={false} axisLine={{ stroke: CHART_GRID }} />
          <YAxis tick={axisTick} tickLine={false} axisLine={false} width={44} />
          <Tooltip formatter={minutesTooltip} />
          <Bar
            dataKey="avgMinutes"
            name="Ø Zeit"
            fill={CHART_COLORS[0]}
            radius={[4, 4, 0, 0]}
            maxBarSize={48}
          />
        </BarChart>
      </CollapsibleChart>
        </>
      )}
    </div>
  );
}
