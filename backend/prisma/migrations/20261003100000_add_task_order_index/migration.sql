-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "orderIndex" INTEGER NOT NULL DEFAULT 0;

-- Backfill: die bisherige Anzeige-Reihenfolge des Aufgaben-Tabs übernehmen
-- (Priorität hoch → niedrig, innerhalb neueste zuerst), damit sich nach dem
-- Einspielen nichts verschiebt.
UPDATE "Task" t
SET "orderIndex" = o.rn
FROM (
  SELECT id,
         (ROW_NUMBER() OVER (
           ORDER BY CASE priority WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
                    "createdAt" DESC
         ) - 1)::int AS rn
  FROM "Task"
) o
WHERE t.id = o.id;
