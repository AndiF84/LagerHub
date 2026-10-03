/*
  Warnings:

  - You are about to drop the column `day` on the `WorkLog` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "WorkLog_day_idx";

-- DropIndex
DROP INDEX "WorkLog_employeeId_day_idx";

-- AlterTable
ALTER TABLE "WorkLog" DROP COLUMN "day";

-- CreateIndex
CREATE INDEX "WorkLog_employeeId_finishedAt_idx" ON "WorkLog"("employeeId", "finishedAt");

-- CreateIndex
CREATE INDEX "WorkLog_finishedAt_idx" ON "WorkLog"("finishedAt");
