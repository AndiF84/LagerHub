// Alters-Anzeige eines Arbeitsschritts: "⏱ 42 min" mit Ampel aus
// Settings.escalationMins. Regeln in lib/stepAge.ts (identisch zum Dashboard).
import type { PoolStep } from "../api/types";
import { ageLevel, formatAge, formatTimestamp, minutesSince, stepAgeBasis } from "../lib/stepAge";

export function StepAge({
  step,
  now,
  escalationMins,
}: {
  step: PoolStep;
  now: number;
  escalationMins: number | undefined;
}) {
  const basis = stepAgeBasis(step);
  if (!basis) return null;

  const minutes = minutesSince(basis.since, now);
  const level = basis.escalate ? ageLevel(minutes, escalationMins) : "calm";

  return (
    <span
      className={`step-age step-age--${level}`}
      title={`${basis.label} ${formatTimestamp(basis.since)}`}
    >
      ⏱ {formatAge(minutes)}
    </span>
  );
}
