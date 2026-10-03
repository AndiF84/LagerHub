/**
 * Legt die Test-Datenbank an und bringt sie auf den aktuellen Migrationsstand.
 *
 * Aufruf: npm run db:test:setup
 *
 * Die Verbindungsdaten kommen aus DATABASE_URL (.env) – nur der Datenbankname
 * wird ausgetauscht (siehe testDatabaseUrl). Damit gibt es keine zweite Datei
 * mit Zugangsdaten und keinen zweiten Satz Passwoerter.
 *
 * Idempotent: existiert die Datenbank schon, wird sie behalten und nur
 * `prisma migrate deploy` erneut ausgefuehrt.
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { testDatabaseUrl, TEST_DB_NAME } from "../testDb.js";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL fehlt – .env pruefen.");

  const target = testDatabaseUrl(url);

  // Zum Anlegen auf eine ANDERE Datenbank verbinden: man kann keine Datenbank
  // erzeugen, waehrend man in ihr sitzt. Die Wartungs-DB "postgres" gibt es immer.
  // Prisma statt eines eigenen pg-Clients; dass dort kein passendes Schema liegt,
  // stoert bei reinem Raw-SQL nicht.
  //
  // Ab Prisma 7 wird die Verbindung als Driver Adapter uebergeben – die frueheren
  // `datasources: { db: { url } }` im Konstruktor gibt es nicht mehr.
  const admin = new PrismaClient({
    adapter: new PrismaPg({ connectionString: testDatabaseUrl(url, "postgres") }),
  });
  const exists = await admin.$queryRaw<{ one: number }[]>`
    SELECT 1 AS one FROM pg_database WHERE datname = ${TEST_DB_NAME}`;
  if (exists.length === 0) {
    // Bezeichner lassen sich nicht binden; TEST_DB_NAME ist eine Konstante aus
    // dem Code, kein Eingabewert. CREATE DATABASE laeuft nicht in einer
    // Transaktion – $executeRawUnsafe schickt es einzeln, das passt.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${TEST_DB_NAME}"`);
    console.log(`  Datenbank ${TEST_DB_NAME} angelegt.`);
  } else {
    console.log(`  Datenbank ${TEST_DB_NAME} besteht bereits.`);
  }
  await admin.$disconnect();

  console.log("  Migrationen werden eingespielt...");
  // Die Prisma-Kommandozeile direkt mit dem laufenden Node starten – weder ueber
  // die Shell (`shell: true` haengt die Argumente nur aneinander statt sie zu
  // escapen) noch ueber npx.cmd: seit dem Node-Sicherheitsfix (CVE-2024-27980)
  // lehnt execFileSync .cmd/.bat ohne Shell mit EINVAL ab.
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, DATABASE_URL: target, DIRECT_URL: target },
  });
  console.log("  Test-Datenbank ist bereit.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
