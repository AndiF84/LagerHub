// Meldungen an den eingeloggten MA, die NICHT aus seiner eigenen Aktion folgen –
// als schließbare Banner über der Arbeitsansicht. Beide Arten kommen über den
// Roh-Event-Verteiler `onRealtimeEvent` (nicht über die Query-Invalidierung), und
// beide werden auf die eigene employeeId gefiltert:
//
//  • WORK_REMINDER       – „du hast anderswo noch etwas unterbrochen" (feuert beim
//                          Abschluss eines Schritts, nicht zeitbasiert; siehe
//                          assignments.ts / presence.ts).
//  • ASSIGNMENT_WITHDRAWN – „die Aufgabe wurde aus dem Pool genommen, du bist
//                          ausgeloggt" (Manager zieht eine noch nicht begonnene
//                          Aufgabe zurück; siehe routes/tasks.ts). Ohne diese
//                          Meldung verschwände der Schritt kommentarlos aus der
//                          Liste – der MA stünde ratlos da.
//
// Hieß früher WorkReminders (nur die erste Art).
import { useEffect, useState } from "react";
import { onRealtimeEvent } from "../api/useRealtime";

type NoticeKind = "REMINDER" | "WITHDRAWN";

interface Notice {
  // Ein Banner je Schritt UND Art: eine Erinnerung soll eine Rückzugs-Meldung
  // zum selben Schritt nicht überschreiben (und umgekehrt).
  key: string;
  kind: NoticeKind;
  stepName: string;
  taskName: string;
}

export function Notices({ userId }: { userId: string }) {
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    return onRealtimeEvent((msg) => {
      const kind: NoticeKind | null =
        msg.type === "WORK_REMINDER"
          ? "REMINDER"
          : msg.type === "ASSIGNMENT_WITHDRAWN"
            ? "WITHDRAWN"
            : null;
      if (!kind) return;
      if (String(msg.employeeId) !== userId) return;

      const next: Notice = {
        key: `${kind}:${String(msg.stepId)}`,
        kind,
        stepName: String(msg.stepName ?? ""),
        taskName: String(msg.taskName ?? ""),
      };
      // Bestehendes Banner ersetzen statt stapeln (keine Dubletten), neueste oben.
      setNotices((prev) => [next, ...prev.filter((n) => n.key !== next.key)]);
    });
  }, [userId]);

  const dismiss = (key: string) => setNotices((prev) => prev.filter((n) => n.key !== key));

  if (notices.length === 0) return null;

  return (
    <div className="reminders">
      {notices.map((n) => (
        <div
          key={n.key}
          className={`reminder${n.kind === "WITHDRAWN" ? " reminder--withdrawn" : ""}`}
        >
          {n.kind === "REMINDER" ? (
            <span>
              ⏸ Du hast „{n.stepName}"{n.taskName ? ` (${n.taskName})` : ""} noch unterbrochen –
              nicht beendet.
            </span>
          ) : (
            <span>
              ↩ „{n.taskName}" wurde zurückgezogen – du bist aus „{n.stepName}" ausgeloggt. Deine
              Zeit auf diesem Schritt wurde nicht gebucht (er war noch nicht gestartet).
            </span>
          )}
          <button
            className="reminder__close"
            title="Schließen"
            aria-label="Meldung schließen"
            onClick={() => dismiss(n.key)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
