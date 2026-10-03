// Prisma-Konfiguration (ab Prisma 7 Pflicht fuer Migrationen/Introspektion).
//
// Warum diese Datei ueberhaupt existiert: bis Prisma 6 standen die
// Verbindungszeichenfolgen als `url`/`directUrl` im `datasource`-Block von
// schema.prisma. Prisma 7 erlaubt das nicht mehr – die Migrations-Verbindung
// gehoert hierher, die Laufzeit-Verbindung baut src/db.ts als Driver Adapter auf.
//
// Die .env wird hier ausdruecklich geladen: die Prisma-CLI liest sie ab Version 7
// nicht mehr von selbst ein. Ohne diese Zeile laufen `prisma migrate`/`generate`
// ohne Verbindung ins Leere.
import "dotenv/config";
import { defineConfig } from "prisma/config";

// DIRECT_URL vor DATABASE_URL: dieselbe Rolle wie das fruehere `directUrl` im
// Schema. Lokal sind beide identisch; die Trennung stammt aus der Supabase-Zeit,
// wo ein Transaction-Pooler kein DDL/Advisory-Lock konnte und Migrationen deshalb
// eine eigene Direktverbindung brauchten. Kommt je wieder ein Pooler davor, ist
// das hier die Stelle, an der die Direktverbindung stehen muss.
const migrationsUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: migrationsUrl ?? "",
  },
});
