import { useEffect, useState } from "react";
import { useRealtime } from "./api/useRealtime";
import { TasksTab } from "./tabs/TasksTab";
import { PoolTab } from "./tabs/PoolTab";
import { EmployeesTab } from "./tabs/EmployeesTab";
import { StatsTab } from "./tabs/StatsTab";
import { HistoryTab } from "./tabs/HistoryTab";
import { SettingsTab } from "./tabs/SettingsTab";
import { RemindersTab } from "./tabs/RemindersTab";
import { LoginScreen } from "./components/LoginScreen";
import { Logo } from "./components/Logo";
import {
  clearSession,
  loadSession,
  ROLE_LABEL,
  saveSession,
  TAB_ACCESS,
  type TabId,
} from "./api/session";
import type { SessionUser } from "./api/types";

const TAB_LABELS: Record<TabId, string> = {
  pool: "Dashboard",
  tasks: "Aufgaben",
  employees: "Mitarbeiter",
  reminders: "Erinnerungen",
  stats: "Statistik",
  history: "Historie",
  settings: "Einstellungen",
};

export function App() {
  const [session, setSession] = useState<SessionUser | null>(() => loadSession());
  const conn = useRealtime(session?.token ?? null);

  // Welche Tabs darf die aktuelle Rolle sehen.
  const allowedTabs = session ? TAB_ACCESS[session.role] : [];
  const [tab, setTab] = useState<TabId>(() => allowedTabs[0] ?? "pool");

  // Nach Login/Rollenwechsel sicherstellen, dass der aktive Tab erlaubt ist.
  useEffect(() => {
    if (allowedTabs.length > 0 && !allowedTabs.includes(tab)) {
      setTab(allowedTabs[0]);
    }
  }, [allowedTabs, tab]);

  const login = (user: SessionUser) => {
    saveSession(user);
    setSession(user);
    const first = TAB_ACCESS[user.role][0];
    if (first) setTab(first);
  };

  const logout = () => {
    clearSession();
    setSession(null);
  };

  if (!session) {
    return <LoginScreen onLogin={login} />;
  }

  return (
    <div className="app">
      <header className="header">
        <Logo />
        <span className={`conn conn--${conn}`}>
          {conn === "open" ? "● Live" : conn === "connecting" ? "● Verbinde…" : "● Getrennt"}
        </span>
        <span style={{ flex: 1 }} />
        <span className="muted">
          {session.name} · {ROLE_LABEL[session.role]}
        </span>
        <button className="btn" onClick={logout}>
          Abmelden
        </button>
      </header>

      {allowedTabs.length === 0 ? (
        // Lager-Mitarbeiter haben im Dashboard nichts – sie nutzen die PWA.
        <main className="content">
          <div className="card">
            <h2 style={{ marginTop: 0 }}>Keine Dashboard-Ansicht</h2>
            <p className="muted">
              Für Lager-Mitarbeiter gibt es im Dashboard keine Ansicht – bitte die
              Mitarbeiter-App (PWA) nutzen.
            </p>
          </div>
        </main>
      ) : (
        <>
          <nav className="tabs">
            {allowedTabs.map((id) => (
              <button
                key={id}
                className={`tab ${tab === id ? "tab--active" : ""}`}
                onClick={() => setTab(id)}
              >
                {TAB_LABELS[id]}
              </button>
            ))}
          </nav>

          <main className="content">
            {tab === "tasks" && <TasksTab />}
            {tab === "pool" && <PoolTab />}
            {tab === "employees" && <EmployeesTab />}
            {tab === "reminders" && (
              <RemindersTab isManager={session.role === "MANAGER" || session.role === "ADMIN"} />
            )}
            {tab === "stats" && <StatsTab />}
            {tab === "history" && (
              <HistoryTab isManager={session.role === "MANAGER" || session.role === "ADMIN"} />
            )}
            {tab === "settings" && <SettingsTab />}
          </main>
        </>
      )}
    </div>
  );
}
