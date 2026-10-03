// Statistik: KPIs aus /api/stats sowie Status-Verteilung und Auslastung.
// (Die Tagesjournale/Historie sind in einen eigenen Tab ausgelagert, s. HistoryTab.)
import {
  useEmployeeLoad,
  useStatsSummary,
  useTasksByStatus,
} from "../api/queries";
import { AnalyticsSection } from "../components/AnalyticsSection";
import { exportEmployeeLoad, exportSummary } from "../lib/statsExport";
import { formatMinutes } from "../lib/formatDuration";
import { useNow } from "../lib/useNow";

// Sekunden als mitlaufende Uhr: "5:09" bzw. "1:05:09" (ab einer Stunde).
function formatClock(totalSeconds: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function StatsTab() {
  const { data: summary, isLoading } = useStatsSummary();
  const { data: byStatus } = useTasksByStatus();
  const { data: load } = useEmployeeLoad();
  const now = useNow();

  return (
    <div>
      <div className="row row--start" style={{ marginBottom: 8 }}>
        <button
          className="btn btn--excel"
          disabled={!summary || !byStatus}
          onClick={() => summary && byStatus && exportSummary(summary, byStatus)}
          title="Kennzahlen und Aufgaben nach Status als Excel-Mappe"
        >
          ⬇ Excel: Tagesübersicht
        </button>
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi__value">{summary?.stepsCompletedToday ?? "–"}</div>
          <div className="kpi__label">Schritte erledigt (heute)</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{summary?.activeEmployees ?? "–"}</div>
          <div className="kpi__label">Aktive Mitarbeiter</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{summary?.poolTasksOpen ?? "–"}</div>
          <div className="kpi__label">Offene Pool-Aufgaben</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">
            {formatMinutes(summary?.avgDurationMinutes)}
          </div>
          <div className="kpi__label">Ø Durchlaufzeit (heute)</div>
        </div>
      </div>
      {isLoading && <p className="muted">Lade Statistik…</p>}

      <h2 style={{ fontSize: 16 }}>Aufgaben nach Status</h2>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi__value">{byStatus?.open ?? "–"}</div>
          <div className="kpi__label">Offen</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{byStatus?.running ?? "–"}</div>
          <div className="kpi__label">Laufend</div>
        </div>
        <div className="kpi">
          <div className="kpi__value">{byStatus?.completed ?? "–"}</div>
          <div className="kpi__label">Abgeschlossen (heute)</div>
        </div>
      </div>

      {/* Button auf eigener Zeile unter der Überschrift: so beginnt er an
          derselben linken Kante wie die übrigen Export-Buttons. */}
      <h2 style={{ fontSize: 16 }}>Mitarbeiter-Auslastung (heute)</h2>
      <div className="row row--start" style={{ marginBottom: 8 }}>
        <button
          className="btn btn--excel"
          disabled={!load || load.length === 0}
          onClick={() => load && exportEmployeeLoad(load, Date.now())}
          title="Aktuelle Mitarbeiter-Auslastung als Excel-Mappe"
        >
          ⬇ Excel: Auslastung
        </button>
      </div>
      {load && load.length === 0 && <p className="muted">Noch keine Aktivität heute.</p>}
      {load && load.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Mitarbeiter</th>
              <th>Aktive Aufgabe</th>
              <th>Zeit (aktuell)</th>
              <th>Aktive Zeit heute</th>
            </tr>
          </thead>
          <tbody>
            {load.map((l) => {
              // Laufende Zuweisung tickt live; Gesamtzeit = fixe Basis + laufend.
              const currentSec =
                l.currentSince != null
                  ? Math.max(0, Math.floor((now - new Date(l.currentSince).getTime()) / 1000))
                  : null;
              const totalSec = Math.floor(l.activeBaseMs / 1000) + (currentSec ?? 0);
              return (
                <tr key={l.employeeId}>
                  <td>{l.name}</td>
                  <td>
                    {l.currentTask ? (
                      <>
                        {l.currentTask}
                        {l.currentStep && (
                          <span className="muted"> · {l.currentStep}</span>
                        )}
                      </>
                    ) : (
                      <span className="muted">— gerade nichts</span>
                    )}
                  </td>
                  <td className="muted">
                    {currentSec != null ? formatClock(currentSec) : "–"}
                  </td>
                  <td>{formatClock(totalSec)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <AnalyticsSection />
    </div>
  );
}
