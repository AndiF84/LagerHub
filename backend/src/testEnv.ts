/**
 * Biegt die Datenbank-Umgebung auf die TEST-Datenbank um.
 *
 * Muss als ERSTER Import in einem Test stehen, der eine echte Datenbank
 * benutzt: `db.ts` baut den PrismaClient beim Laden des Moduls und liest
 * DATABASE_URL dabei genau einmal. Als Seiteneffekt-Import (statt als
 * Zuweisung im Test) laeuft das zuverlaessig vorher – die Reihenfolge von
 * Imports bleibt in CommonJS wie in ESM erhalten, eine Zuweisung im
 * Dateikopf wuerde dagegen erst nach allen Imports ausgefuehrt.
 */
import "dotenv/config";
import { testDatabaseUrl } from "./testDb.js";

const base = process.env.DATABASE_URL;
if (base) {
  const target = testDatabaseUrl(base);
  process.env.DATABASE_URL = target;
  process.env.DIRECT_URL = target;
}

// buildServer() steigt ohne Secret bewusst mit einem Fehler aus. Im Test darf
// es ein beliebiger Wert sein – aber ein vorhandenes echtes Secret wird nicht
// ueberschrieben.
process.env.JWT_SECRET ??= "test-secret-nur-fuer-tests";
