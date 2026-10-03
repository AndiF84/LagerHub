// Historie: alle Tagesjournale (abgeschlossene Durchläufe). Früher Teil des
// Statistik-Tabs, jetzt eigener Tab – u. a. damit Büro-Nutzer die Historie sehen
// können, ohne die restliche Statistik zu bekommen.
import { useState } from "react";
import {
  useDeleteJournalDay,
  useJournalByDate,
  useJournalDays,
} from "../api/queries";
import { JournalRunCard } from "../components/JournalRunCard";
import { ReminderJournal } from "../components/ReminderJournal";

// "YYYY-MM-DD" → "18.06.2026"
function formatDate(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}.${m}.${y}`;
}

// Server-Lokaltag von heute als "YYYY-MM-DD" (für die Lösch-Sperre im UI).
function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function JournalDayDetails({ date }: { date: string }) {
  const { data: entries, isLoading } = useJournalByDate(date);
  if (isLoading) return <p className="muted">Lade Durchläufe…</p>;
  // Ein Tag kann NUR aus Erinnerungs-Entscheidungen bestehen (niemand hat eine
  // Aufgabe abgeschlossen, aber jemand hat etwas abgehakt) – deshalb bleibt der
  // Bereich auch ohne Durchläufe stehen, statt "Keine Durchläufe" zu melden
  // und die Entscheidungen zu verschlucken.
  return (
    <div style={{ marginTop: 8 }}>
      {(!entries || entries.length === 0) && <p className="muted">Keine Durchläufe.</p>}
      {entries?.map((e) => (
        <JournalRunCard key={e.id} run={e} />
      ))}
      <ReminderJournal date={date} />
    </div>
  );
}


// Standardmäßig nur die letzten N Tage zeigen; ältere über die Von/Bis-Auswahl.
const JOURNAL_DAYS_LIMIT = 5;

export function HistoryTab({ isManager }: { isManager: boolean }) {
  const { data: days } = useJournalDays();
  const deleteDay = useDeleteJournalDay();
  const [openDate, setOpenDate] = useState<string | null>(null);
  // Entwurf (Eingabefelder) vs. angewendeter Filter: die Auswahl greift erst
  // nach Klick auf "Suchen", nicht schon beim Tippen ins Datumsfeld.
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [applied, setApplied] = useState<{ from: string; to: string } | null>(null);
  const today = todayKey();

  const all = days ?? [];
  // Ist ein Zeitraum angewendet? Dann ALLE passenden Tage zeigen, sonst die
  // letzten N (Liste kommt bereits absteigend = neueste zuerst).
  const filtering = applied !== null;
  const shown = filtering
    ? all.filter(
        (d) =>
          (applied.from === "" || d.date >= applied.from) &&
          (applied.to === "" || d.date <= applied.to),
      )
    : all.slice(0, JOURNAL_DAYS_LIMIT);

  return (
    <div>
      <h2 style={{ fontSize: 16, marginTop: 0 }}>Tagesjournale (Historie)</h2>
      {/* row--start: sonst zieht space-between Von/Bis/Suchen auseinander,
          sobald der lange Hinweistext dem kurzen "Zurücksetzen" weicht. */}
      <div className="row row--start" style={{ gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        <label className="muted">
          Von{" "}
          <input type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="muted">
          Bis{" "}
          <input type="date" value={to} min={from || undefined} max={today} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button
          className="btn"
          disabled={from === "" && to === ""}
          onClick={() => setApplied({ from, to })}
        >
          Suchen
        </button>
        {filtering ? (
          <button className="btn" onClick={() => { setFrom(""); setTo(""); setApplied(null); }}>
            Zurücksetzen
          </button>
        ) : (
          all.length > JOURNAL_DAYS_LIMIT && (
            <span className="muted">
              Es werden die letzten {JOURNAL_DAYS_LIMIT} Tage gezeigt – für ältere einen Zeitraum wählen und „Suchen".
            </span>
          )
        )}
      </div>
      {all.length === 0 && (
        <p className="muted">Noch keine abgeschlossenen Durchläufe.</p>
      )}
      {filtering && shown.length === 0 && (
        <p className="muted">Keine Journale im gewählten Zeitraum.</p>
      )}
      {shown.map((d) => {
        const isToday = d.date >= today;
        return (
          <div key={d.date} className="card">
            <div className="row" style={{ gap: 12, alignItems: "center" }}>
              <button
                className="btn"
                onClick={() => setOpenDate(openDate === d.date ? null : d.date)}
                aria-expanded={openDate === d.date}
                title={openDate === d.date ? "Einklappen" : "Aufklappen"}
              >
                {openDate === d.date ? "▾" : "▸"}
              </button>
              <strong>{formatDate(d.date)}</strong>
              <span className="muted">{d.count} Durchläufe</span>
              <span style={{ flex: 1 }} />
              {/* Löschen ist serverseitig authManager (DELETE /stats/journal/:date).
                  Für OFFICE den Knopf gar nicht erst zeigen – er lief dort in einen
                  403, den der onError-alert() als roher Fehlertext ausgab. */}
              {isManager && (
              <button
                className="btn"
                disabled={isToday || deleteDay.isPending}
                title={isToday ? "Der heutige Tag kann nicht gelöscht werden" : "Tag löschen"}
                onClick={() => {
                  if (
                    confirm(
                      `Tagesjournal vom ${formatDate(d.date)} mit ${d.count} Durchläufen endgültig löschen?`,
                    )
                  ) {
                    if (openDate === d.date) setOpenDate(null);
                    deleteDay.mutate(d.date, { onError: (e) => alert(String(e)) });
                  }
                }}
              >
                Tag löschen
              </button>
              )}
            </div>
            {openDate === d.date && <JournalDayDetails date={d.date} />}
          </div>
        );
      })}
    </div>
  );
}
