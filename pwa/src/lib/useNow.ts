import { useEffect, useState } from "react";

// Mitlaufende Uhr: re-rendert die Komponente im gewünschten Takt.
// Gegenstück zu frontend/src/lib/useNow.ts (die Apps teilen bewusst keinen Code).
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
