import { useState } from "react";
import { LoginScreen } from "./components/LoginScreen";
import { Logo } from "./components/Logo";
import { PoolList } from "./components/PoolList";
import { Notices } from "./components/Notices";
import { PushToggle } from "./components/PushToggle";
import { useRealtime } from "./api/useRealtime";
import { disablePush } from "./api/push";
import { clearSession, loadSession, saveSession } from "./api/session";
import type { MaUser } from "./api/types";

// M2 – nach dem Login (M1) die mobile Arbeitsansicht: der MA sieht seine
// passenden, freigegebenen Schritte und kann sich einloggen / abschließen /
// unterbrechen (PoolList). WS hält den Pool live aktuell. M3 Angebote/Notizen,
// M4 Push-Benachrichtigungen (PushToggle + Service Worker).
export function App() {
  const [user, setUser] = useState<MaUser | null>(() => loadSession());
  const conn = useRealtime(user?.token ?? null);

  const login = (u: MaUser) => {
    saveSession(u);
    setUser(u);
  };
  const logout = async () => {
    // Push-Abo entfernen, solange das Token noch gültig ist (sonst bekäme auf
    // diesem Gerät der nächste MA weiter Pushes des vorigen).
    await disablePush().catch(() => {});
    clearSession();
    setUser(null);
  };

  if (!user) return <LoginScreen onLogin={login} />;

  return (
    <div className="app">
      <header className="topbar">
        <Logo />
        <span className="muted">{user.name}</span>
        <span style={{ flex: 1 }} />
        <span className={`conn conn--${conn}`} title={`Verbindung: ${conn}`} />
        <button className="btn topbar__btn" onClick={logout}>
          Abmelden
        </button>
      </header>
      <main className="content">
        <PushToggle />
        <Notices userId={user.id} />
        <PoolList user={user} />
      </main>
    </div>
  );
}
