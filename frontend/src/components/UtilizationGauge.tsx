// Auslastungstacho fürs Dashboard. Leitet alles aus den ohnehin geladenen
// Pool- und Mitarbeiterdaten ab (kein eigener Endpoint):
//  - Personalauslastung = anwesende MA im Einsatz ÷ anwesende MA (große Zahl)
//  - Schritt-Besetzung: besetzt (ACTIVE) / offen (OPEN) / pausiert (PAUSED) /
//    wartet auf Team (WAITING – Team-Schritt noch unter Mindestbesetzung)
//  - Schritte, die JETZT besetzbar sind (offen ODER wartend, und es gibt eine freie,
//    anwesende, passend qualifizierte Kraft) vs. Engpässe (keine solche Kraft)
// Jede Kennzahl ist ein Button: ein Klick klappt darunter die passende Detailliste
// auf (welche MA / welche Schritte). Funktioniert für alle Dashboard-Rollen.
import { useMemo, useState, type ReactNode } from "react";
import type { Employee, Step, Task } from "../api/types";

// Farbe nach Auslastung: viel Reserve (Navy = neutral, kein Alarm) → gut
// ausgelastet (grün) → kaum Reserve (amber). Navy statt des früheren Blaus,
// damit der Tacho in der Marken-Palette bleibt; grün/amber sind Semantik-Farben
// und bleiben unverändert. Hex statt var(), weil CSS-Variablen in SVG-
// Präsentationsattributen (fill/stroke) nicht aufgelöst werden.
function arcColor(v: number): string {
  if (v < 0.4) return "#212c3d";
  if (v <= 0.8) return "#14804a";
  return "#9a6a00";
}

// Endpunkt des Füll-Bogens auf dem oberen Halbkreis (Mittelpunkt 110/110, r=90).
// v = 0 → links (20/110), v = 1 → rechts (200/110).
function arcEnd(v: number): { x: number; y: number } {
  const rad = (Math.PI / 180) * (180 - 180 * v);
  return { x: 110 + 90 * Math.cos(rad), y: 110 - 90 * Math.sin(rad) };
}

// Welche Detailliste ist gerade aufgeklappt.
type DetailKey =
  | "present"
  | "active"
  | "free"
  | "occupied"
  | "paused"
  | "waiting"
  | "open"
  | "staffable"
  | "bottleneck";

type StepWithTask = { step: Step; taskName: string };

function Chip({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number | string;
  tone?: "ok" | "warn";
  active?: boolean;
  onClick?: () => void;
}) {
  const color = tone === "ok" ? "#14804a" : tone === "warn" ? "#b42318" : "var(--brand)";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: 6,
        padding: "6px 10px",
        // Aufgeklappte Kennzahl in Gold hinterlegt – dieselbe Sprache wie der
        // aktive Tab, statt des früheren Blaus außerhalb der Palette.
        background: active ? "var(--accent-soft)" : "#f4f5f7",
        border: `1px solid ${active ? "var(--accent-600)" : "var(--border)"}`,
        borderRadius: 8,
        fontSize: 13,
        cursor: "pointer",
        font: "inherit",
        transition: "background 0.15s ease, border-color 0.15s ease",
      }}
    >
      <strong style={{ fontSize: 16, color }}>{value}</strong>
      <span className="muted">{label}</span>
    </button>
  );
}

// Aufklappbare Detailliste unter den Kennzahlen.
function DetailList({ title, rows }: { title: string; rows: ReactNode[] }) {
  return (
    <div
      style={{
        flexBasis: "100%",
        marginTop: 4,
        padding: "10px 12px",
        background: "#fafbfc",
        border: "1px solid #e3e5e8",
        borderRadius: 8,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      {rows.length === 0 ? (
        <div className="muted" style={{ fontSize: 13 }}>
          keine
        </div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, maxHeight: 220, overflowY: "auto" }}>
          {rows}
        </ul>
      )}
    </div>
  );
}

export function UtilizationGauge({
  pool,
  employees,
}: {
  pool: Task[] | undefined;
  employees: Employee[] | undefined;
}) {
  const [detail, setDetail] = useState<DetailKey | null>(null);

  const m = useMemo(() => {
    const emps = employees ?? [];
    const total = emps.length;
    const present = emps.filter((e) => e.present);
    const presentActive = present.filter((e) => e.status === "active");
    const presentFree = present.filter((e) => e.status !== "active");
    const utilization = present.length > 0 ? presentActive.length / present.length : 0;

    // Fähigkeiten, für die gerade eine freie, anwesende Kraft bereitsteht.
    const freeSkillIds = new Set(presentFree.flatMap((e) => e.skills.map((s) => s.skill.id)));

    // Schritte samt Aufgabenname (für die Detaillisten).
    const steps: StepWithTask[] = (pool ?? []).flatMap((t) =>
      t.steps.map((step) => ({ step, taskName: t.name })),
    );
    const byStatus = (s: string) => steps.filter((x) => x.step.computedStatus === s);
    const occupied = byStatus("ACTIVE");
    const paused = byStatus("PAUSED");
    const open = byStatus("OPEN");
    const waiting = byStatus("WAITING");
    // Schritte, die noch eine (weitere) freie Kraft brauchen: unbesetzte (OPEN)
    // UND wartende (WAITING).
    const needWorker = [...open, ...waiting];
    const staffable = needWorker.filter((x) => freeSkillIds.has(x.step.skill.id));
    const bottleneck = needWorker.filter((x) => !freeSkillIds.has(x.step.skill.id));
    const bottleneckSkills = [...new Set(bottleneck.map((x) => x.step.skill.name))];

    return {
      total,
      present,
      presentActive,
      presentFree,
      utilization,
      occupied,
      paused,
      open,
      waiting,
      staffable,
      bottleneck,
      bottleneckSkills,
    };
  }, [pool, employees]);

  if (!employees) return null;

  const pct = Math.round(m.utilization * 100);
  const color = arcColor(m.utilization);
  const end = arcEnd(m.utilization);
  const nonePresent = m.present.length === 0;
  const toggle = (k: DetailKey) => setDetail((cur) => (cur === k ? null : k));

  // Zeilen für Personen- bzw. Schritt-Listen.
  const personRow = (e: Employee, withStep: boolean) => (
    <li key={e.id}>
      {e.name}
      {withStep && e.currentStep && (
        <span className="muted">
          {" – "}
          {e.currentStep.taskName} / {e.currentStep.stepName}
        </span>
      )}
      {!withStep && e.skills.length > 0 && (
        <span className="muted"> · {e.skills.map((s) => s.skill.name).join(", ")}</span>
      )}
    </li>
  );
  const stepRow = (x: StepWithTask) => (
    <li key={x.step.id}>
      {x.taskName} <span className="muted">/ {x.step.name}</span>
    </li>
  );

  // Inhalt je Detail-Auswahl.
  const details: Record<DetailKey, { title: string; rows: ReactNode[] }> = {
    present: { title: "Anwesende Mitarbeiter", rows: m.present.map((e) => personRow(e, e.status === "active")) },
    active: { title: "Im Einsatz", rows: m.presentActive.map((e) => personRow(e, true)) },
    free: { title: "Frei (anwesend, nicht im Einsatz)", rows: m.presentFree.map((e) => personRow(e, false)) },
    occupied: { title: "Besetzte Schritte", rows: m.occupied.map(stepRow) },
    paused: { title: "Unterbrochene Schritte", rows: m.paused.map(stepRow) },
    waiting: { title: "Wartet auf Team", rows: m.waiting.map(stepRow) },
    open: { title: "Offene Schritte", rows: m.open.map(stepRow) },
    staffable: { title: "Sofort besetzbare Schritte", rows: m.staffable.map(stepRow) },
    bottleneck: { title: "Engpass (keine freie passende Kraft)", rows: m.bottleneck.map(stepRow) },
  };

  return (
    <div className="card" style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "center" }}>
      {/* Tacho */}
      <div style={{ textAlign: "center" }}>
        <svg viewBox="0 0 220 128" width={220} style={{ maxWidth: "100%", display: "block" }}>
          <path d="M 20 110 A 90 90 0 0 1 200 110" fill="none" stroke="#e4e7eb" strokeWidth={16} strokeLinecap="round" />
          {m.utilization > 0 && !nonePresent && (
            <path
              d={`M 20 110 A 90 90 0 0 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`}
              fill="none"
              stroke={color}
              strokeWidth={16}
              strokeLinecap="round"
            />
          )}
          <text x={110} y={96} textAnchor="middle" fontSize={36} fontWeight={700} fill={nonePresent ? "#9aa0a6" : color}>
            {nonePresent ? "–" : `${pct} %`}
          </text>
        </svg>
        <div className="muted" style={{ marginTop: -4 }}>
          {nonePresent
            ? "Niemand anwesend"
            : `${m.presentActive.length} von ${m.present.length} anwesenden im Einsatz`}
        </div>
      </div>

      {/* Kennzahlen (klickbar) */}
      <div style={{ flex: 1, minWidth: 260 }}>
        <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>Team-Auslastung</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
          <Chip label={`anwesend (von ${m.total})`} value={m.present.length} active={detail === "present"} onClick={() => toggle("present")} />
          <Chip label="im Einsatz" value={m.presentActive.length} active={detail === "active"} onClick={() => toggle("active")} />
          <Chip label="frei" value={m.presentFree.length} active={detail === "free"} onClick={() => toggle("free")} />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Chip label="Schritte besetzt" value={m.occupied.length} active={detail === "occupied"} onClick={() => toggle("occupied")} />
          {m.paused.length > 0 && (
            <Chip label="unterbrochen" value={m.paused.length} active={detail === "paused"} onClick={() => toggle("paused")} />
          )}
          {m.waiting.length > 0 && (
            <Chip label="wartet auf Team" value={m.waiting.length} tone="warn" active={detail === "waiting"} onClick={() => toggle("waiting")} />
          )}
          <Chip label="offen" value={m.open.length} active={detail === "open"} onClick={() => toggle("open")} />
          <Chip label="sofort besetzbar" value={m.staffable.length} tone={m.staffable.length > 0 ? "ok" : undefined} active={detail === "staffable"} onClick={() => toggle("staffable")} />
          <Chip label="Engpass" value={m.bottleneck.length} tone={m.bottleneck.length > 0 ? "warn" : undefined} active={detail === "bottleneck"} onClick={() => toggle("bottleneck")} />
        </div>
        {m.bottleneck.length > 0 && (
          <div className="muted" style={{ marginTop: 10, color: "#b42318" }}>
            Keine freie passende Kraft für: {m.bottleneckSkills.join(", ")}
          </div>
        )}
      </div>

      {/* Aufgeklappte Detailliste (volle Breite) */}
      {detail && <DetailList title={details[detail].title} rows={details[detail].rows} />}
    </div>
  );
}
