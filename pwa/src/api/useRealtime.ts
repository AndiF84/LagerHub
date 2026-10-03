// WebSocket-Anbindung an /ws – wie im Manager-Frontend NUR ein Signal: bei einem
// pool-relevanten Ereignis vom Bus wird der Pool-Query invalidiert (nichts aus dem
// Payload wird in den State gepatcht). Auto-Reconnect alle 2 s. Bewusst schlank:
// die PWA kennt vorerst nur den Pool.
import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queries";

// Events, die den Pool des MA verändern können. Deckungsgleich mit den
// pool-betreffenden Einträgen der EVENT_MAP im Manager-Frontend.
const POOL_EVENTS = new Set([
  "TASK_CREATED",
  "TASK_UPDATED",
  "TASK_PRIORITY_HIGH",
  "TASK_COMPLETED",
  "TASK_RESTARTED",
  "TASK_DELETED",
  "STEP_CREATED",
  "STEP_UPDATED",
  "STEP_DELETED",
  "STEP_TIMER_STARTED",
  "STEP_UNLOCKED",
  "STEPS_REORDERED",
  "STEP_NOTE_UPDATED",
  "ASSIGNMENT_CHANGED",
  "ASSIGNMENT_OFFERED",
  "ASSIGNMENT_REJECTED",
  // Redundant (TASK_UPDATED/ASSIGNMENT_CHANGED kommen mit), aber die Liste soll
  // vollständig sein: nach dem Rückzug ist die Aufgabe aus dem Pool verschwunden.
  "ASSIGNMENT_WITHDRAWN",
  "TEAM_UNDERSTAFFED",
  "END_OF_DAY",
  "SKILL_UPDATED",
]);

// Ein Burst mehrerer Events (z. B. ASSIGNMENT_CHANGED + STEP_TIMER_STARTED) soll
// nur eine Refetch-Welle auslösen – daher ein kurzes Sammel-Fenster.
const COALESCE_MS = 200;

export type ConnStatus = "connecting" | "open" | "closed";

// Roh-Event-Verteiler (wie im Manager-Frontend): manche Komponenten wollen nicht
// nur invalidieren, sondern auf den Payload reagieren – z. B. die Erinnerung an
// eigene unterbrochene Schritte (WORK_REMINDER). Ein modulweiter Verteiler,
// gespeist von der einzigen WS-Verbindung.
export type RealtimeMessage = { type: string; [key: string]: unknown };
const listeners = new Set<(msg: RealtimeMessage) => void>();

export function onRealtimeEvent(fn: (msg: RealtimeMessage) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Der Socket wird mit dem JWT als Query-Param verbunden (Browser-WS kann keinen
// Authorization-Header setzen); ohne Token (nicht angemeldet) wird nicht verbunden.
export function useRealtime(token: string | null) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // false bis zur ersten offenen Verbindung – danach ist jedes onopen ein
  // Wiederverbinden.
  const reconnectedRef = useRef(false);

  useEffect(() => {
    let closedByUnmount = false;

    if (!token) {
      setStatus("closed");
      return;
    }

    const scheduleInvalidate = () => {
      if (flushRef.current) return;
      flushRef.current = setTimeout(() => {
        flushRef.current = null;
        qc.invalidateQueries({ queryKey: queryKeys.pool });
      }, COALESCE_MS);
    };

    function connect() {
      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token!)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("open");
        // Wie im Dashboard: nach einem Abriss ist offen, was in der Luecke
        // passiert ist – der Bus wiederholt nichts. Ohne Nachladen bliebe die
        // Arbeitsansicht auf einem alten Stand stehen.
        if (reconnectedRef.current) {
          qc.invalidateQueries({ queryKey: queryKeys.pool });
          qc.invalidateQueries({ queryKey: queryKeys.settings });
        }
        reconnectedRef.current = true;
      };

      ws.onmessage = (ev) => {
        let msg: RealtimeMessage | undefined;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!msg?.type) return;
        if (POOL_EVENTS.has(msg.type)) scheduleInvalidate();
        // Ändert der Manager den Eskalations-Schwellwert, muss die Alters-Ampel
        // der Schritte nachziehen (eigener Key, langer staleTime – ohne das
        // bliebe der alte Wert bis zum nächsten App-Start stehen).
        if (msg.type === "SETTINGS_UPDATED") {
          qc.invalidateQueries({ queryKey: queryKeys.settings });
        }
        // Rohes Event an Abonnenten weiterreichen (z. B. WORK_REMINDER).
        for (const fn of listeners) fn(msg);
      };

      ws.onclose = () => {
        setStatus("closed");
        if (!closedByUnmount) retryRef.current = setTimeout(connect, 2000);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      closedByUnmount = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      if (flushRef.current) clearTimeout(flushRef.current);
      wsRef.current?.close();
    };
  }, [qc, token]);

  return status;
}
