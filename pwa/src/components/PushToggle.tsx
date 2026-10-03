// Benachrichtigungs-Umschalter (M4). Zeigt je nach Zustand einen Aktivieren-
// Button, einen Aktiv-Hinweis mit Abschalten oder einen Grund, warum Push gerade
// nicht geht. Die Berechtigungsabfrage läuft nur über den Button-Klick (Nutzer-Geste).
import { useEffect, useState } from "react";
import { enablePush, getPushState, type PushState } from "../api/push";

export function PushToggle() {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getPushState()
      .then(setState)
      .catch(() => setState("unsupported"));
  }, []);

  const activate = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await enablePush());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Nichts anzeigen, wenn schon aktiv oder wenn Push hier gar nicht möglich ist
  // (unsupported). Der Insecure-/Denied-Fall bekommt einen kurzen Hinweis.
  if (state === "loading" || state === "enabled" || state === "unsupported") return null;

  if (state === "blocked-insecure") {
    return (
      <div className="push-bar push-bar--muted">
        🔔 Benachrichtigungen brauchen HTTPS – über die LAN-Adresse nicht verfügbar.
      </div>
    );
  }

  if (state === "denied") {
    return (
      <div className="push-bar push-bar--muted">
        🔔 Benachrichtigungen sind blockiert – bitte in den Browser-Einstellungen für diese Seite erlauben.
      </div>
    );
  }

  // state === "prompt"
  return (
    <div className="push-bar">
      <span>🔔 Benachrichtigungen für neue Aufgaben aktivieren?</span>
      <button className="btn btn--primary" disabled={busy} onClick={activate}>
        {busy ? "Aktiviere…" : "Aktivieren"}
      </button>
      {error && <span className="push-bar__error">{error}</span>}
    </div>
  );
}
