-- CreateEnum
CREATE TYPE "Role" AS ENUM ('MANAGER', 'OFFICE', 'WORKER');

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN     "role" "Role" NOT NULL DEFAULT 'WORKER';
