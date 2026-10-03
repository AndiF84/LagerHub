// WebSocket-Anbindung an /ws. Der Socket dient NUR als Signal: kommt ein
// relevantes Ereignis vom Bus, werden die betroffenen Queries invalidiert. Es wird
// nichts aus den Event-Payloads in den State gepatcht.
import { useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queries";

type QueryKey = readonly unknown[];

// Welche Query-Keys ein Event betrifft. ["stats"] trifft per Prefix-Match alle
// Stats-Queries (summary, tasks-by-status, employee-load).
const EVENT_MAP: Record<string, QueryKey[]> = {
  SKILL_CREATED: [queryKeys.skills],
  SKILL_UPDATED: [queryKeys.skills, queryKeys.employees, queryKeys.tasks, queryKeys.pool],
  SKILL_DELETED: [queryKeys.skills, queryKeys.employees],
  EMPLOYEE_CREATED: [queryKeys.employees],
  EMPLOYEE_UPDATED: [queryKeys.employees],
  EMPLOYEE_DEVICE_RESET: [queryKeys.employees],
  EMPLOYEE_DELETED: [queryKeys.employees, ["stats"]],
  TASK_CREATED: [queryKeys.tasks, queryKeys.pool, ["stats"]],
  TASK_UPDATED: [queryKeys.tasks, queryKeys.pool, ["stats"]],
  TASK_PRIORITY_HIGH: [queryKeys.tasks, queryKeys.pool],
  TASK_COMPLETED: [queryKeys.tasks, queryKeys.pool, ["stats"]],
  TASK_RESTARTED: [queryKeys.tasks, queryKeys.pool, ["stats"]],
  TASK_DELETED: [queryKeys.tasks, queryKeys.pool, ["stats"]],
  STEP_CREATED: [queryKeys.tasks, queryKeys.pool],
  STEP_UPDATED: [queryKeys.tasks, queryKeys.pool],
  STEP_DELETED: [queryKeys.tasks, queryKeys.pool],
  STEP_TIMER_STARTED: [queryKeys.tasks, queryKeys.pool],
  STEPS_REORDERED: [queryKeys.tasks, queryKeys.pool],
  // Reihenfolge der Aufgaben (Aufgaben-Tab) – wirkt im Dashboard als
  // Gleichstand-Ordnung bei gleicher Priorität, daher auch der Pool.
  TASKS_REORDERED: [queryKeys.tasks, queryKeys.pool],
  STEP_NOTE_UPDATED: [queryKeys.tasks, queryKeys.pool],
  // Historie-Journal geändert/gelöscht → alle Stats-Queries (Prefix-Match).
  JOURNAL_UPDATED: [["stats"]],
  JOURNAL_DELETED: [["stats"]],
  ASSIGNMENT_CHANGED: [queryKeys.tasks, queryKeys.pool, queryKeys.employees, ["stats"]],
  ASSIGNMENT_OFFERED: [queryKeys.tasks, queryKeys.pool, queryKeys.employees],
  ASSIGNMENT_REJECTED: [queryKeys.pool, queryKeys.employees],
  TEAM_UNDERSTAFFED: [queryKeys.tasks, queryKeys.pool],
  END_OF_DAY: [queryKeys.tasks, queryKeys.pool, queryKeys.employees, ["stats"]],
  ESCALATION: [queryKeys.tasks],
  // Erinnerungen: Liste im Tab, Banner im Dashboard und - weil jede
  // Entscheidung im Tagesjournal landet - der komplette stats-Prefix.
  REMINDER_UPDATED: [queryKeys.reminders, ["stats"]],
  // Settings-Änderung → Retention-Anzeige im Historie-Tab aktuell halten.
  SETTINGS_UPDATED: [queryKeys.settings],
  // WORK_REMINDER: keine der Tabs betroffen
};

// Eine Aktion löst im Backend oft mehrere Events kurz hintereinander aus
// (z. B. ASSIGNMENT_CHANGED + STEP_TIMER_STARTED + TASK_UPDATED). Ohne Bündelung
// würde jedes Event sofort eine eigene Refetch-Welle starten. Wir sammeln die
// betroffenen Keys in einem kurzen Fenster und invalidieren jeden Key nur einmal.
const COALESCE_MS = 200;
const pendingKeys = new Map<string, QueryKey>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleInvalidate(qc: QueryClient, keys: QueryKey[]) {
  for (const key of keys) pendingKeys.set(JSON.stringify(key), key);
  if (flushTimer) return; // Flush für dieses Fenster ist bereits geplant
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const batch = [...pendingKeys.values()];
    pendingKeys.clear();
    for (const key of batch) qc.invalidateQueries({ queryKey: key });
  }, COALESCE_MS);
}

export type ConnStatus = "connecting" | "open" | "closed";

// Zusätzlich zur Cache-Invalidierung können Komponenten rohe Events abonnieren
// (z. B. das Dashboard für die Ablehnungs-Meldung). Ein modulweiter Verteiler,
// der von der einzigen WS-Verbindung gespeist wird.
export type RealtimeMessage = { type: string; [key: string]: unknown };
const listeners = new Set<(msg: RealtimeMessage) => void>();

export function onRealtimeEvent(fn: (msg: RealtimeMessage) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Der Socket wird mit dem JWT als Query-Param verbunden (Browser-WS kann keinen
// Authorization-Header setzen); ohne Token wird nicht verbunden. Bei An-/Abmelden
// (Token ändert sich) baut der Effekt die Verbindung neu auf.
export function useRealtime(token: string | null) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // false bis zur ersten offenen Verbindung – danach ist jedes onopen ein
  // Wiederverbinden und damit ein Nachladen wert.
  const reconnectedRef = useRef(false);

  useEffect(() => {
    let closedByUnmount = false;

    // Ohne Token (nicht angemeldet) gar nicht erst verbinden.
    if (!token) {
      setStatus("closed");
      return;
    }

    function connect() {
      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token!)}`);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("open");
        // Nach einem Verbindungsabriss ist unbekannt, welche Ereignisse in der
        // Luecke gefallen sind – der Bus wiederholt nichts. Ohne ein Nachladen
        // zeigte die Oberflaeche bis zum naechsten Ereignis stillschweigend
        // veraltete Daten. Beim ERSTEN Verbinden ist das unnoetig (die Queries
        // laufen ohnehin gerade), deshalb der Merker.
        if (reconnectedRef.current) qc.invalidateQueries();
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

        const keys = EVENT_MAP[msg.type];
        if (keys) scheduleInvalidate(qc, keys);
        // Rohes Event an Abonnenten weiterreichen
        for (const fn of listeners) fn(msg);
      };

      ws.onclose = () => {
        setStatus("closed");
        if (!closedByUnmount) {
          retryRef.current = setTimeout(connect, 2000); // Auto-Reconnect
        }
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      closedByUnmount = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [qc, token]);

  return status;
}
