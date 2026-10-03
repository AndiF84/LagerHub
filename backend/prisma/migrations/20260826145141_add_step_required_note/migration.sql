-- CreateEnum
CREATE TYPE "NoteFormat" AS ENUM ('TEXT', 'NUMBER');

-- AlterTable
ALTER TABLE "Step" ADD COLUMN     "noteFormat" "NoteFormat" NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "noteLabel" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "noteRequired" BOOLEAN NOT NULL DEFAULT false;
