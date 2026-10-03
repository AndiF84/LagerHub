-- AlterTable
ALTER TABLE "Step" ADD COLUMN     "availableAt" TIMESTAMP(3);

-- Backfill für den laufenden Betrieb: Schritte, die JETZT schon abholbar sind,
-- bekommen den Migrationszeitpunkt als Startwert. Ohne das zeigten alle
-- aktuell im Pool stehenden Aufgaben bis zu ihrem nächsten Lauf gar kein Alter.
--
-- Bewusste Ungenauigkeit: die tatsächliche Wartezeit VOR der Migration ist nicht
-- rekonstruierbar (genau deshalb gibt es die Spalte). Die Uhr startet also bei 0
-- und ist ab dem nächsten Lauf exakt. Nebeneffekt: kein Eskalations-Schwall
-- direkt nach dem Deployment.
--
-- Nur wirklich OFFENE Schritte stempeln – ein noch GESPERRTER Schritt bekäme
-- sonst eine Zeit, die vor seiner Freigabe liegt, und würde bei Freischaltung
-- mit einem überhöhten Alter erscheinen (exakt der Fehler, den die Spalte behebt).
UPDATE "Step" s
SET "availableAt" = now()
FROM "Task" t
WHERE s."taskId" = t.id
  AND t."poolEnabled" = true
  AND t."deletedAt" IS NULL
  -- Schritt selbst noch unberührt (keine Zuweisung) → Kandidat für OPEN
  AND NOT EXISTS (SELECT 1 FROM "Assignment" a WHERE a."stepId" = s.id)
  -- ... und kein Vorgänger, der NICHT erledigt ist (gleiche Regel wie isStepDone
  -- in services/stepStatus.ts: Team-Schritt = irgendeine DONE-Zuweisung;
  -- Einzel-Schritt = eine DONE und keine ACTIVE/PAUSED mehr).
  AND NOT EXISTS (
    SELECT 1
    FROM "StepPredecessor" sp
    JOIN "Step" p ON p.id = sp."predecessorId"
    WHERE sp."stepId" = s.id
      AND NOT (
        EXISTS (
          SELECT 1 FROM "Assignment" pa
          WHERE pa."stepId" = p.id AND pa.state = 'DONE'
        )
        AND (
          COALESCE(p."minWorkers", 0) >= 2
          OR NOT EXISTS (
            SELECT 1 FROM "Assignment" pa2
            WHERE pa2."stepId" = p.id AND pa2.state IN ('ACTIVE', 'PAUSED')
          )
        )
      )
  );
