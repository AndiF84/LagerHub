import { useEffect, useState } from "react";

// Mitlaufende Uhr: re-rendert die Komponente im gewünschten Takt.
//
// Stand vorher nur lokal in tabs/StatsTab.tsx (Sekundentakt für die Auslastungs-
// Uhren); die Alters-Anzeige der Schritte (components/StepAge.tsx) braucht
// dasselbe, dort aber im Minutenbereich – daher hier als gemeinsame Stelle.
//
// Takt bewusst als Parameter: eine Anzeige in ganzen Minuten muss nicht
// sekündlich neu rendern (das Dashboard zeigt viele Schritte gleichzeitig).
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
