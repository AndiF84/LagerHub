import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Prisma mit Event-basiertem Query-Logging aufbauen und einen Handler anhängen,
// der nur langsame Queries (> 5 ms) ausgibt: "${duration}ms ${query}" (Query gekürzt).
function createPrismaClient() {
  // Ab Prisma 7 kommt die Verbindung NICHT mehr aus schema.prisma (dort ist `url`
  // nicht mehr erlaubt), sondern als Driver Adapter. Fachlich unverändert: dieselbe
  // lokale PostgreSQL. Die Migrations-Verbindung steht in ../prisma.config.ts.
  //
  // DATABASE_URL wird hier beim Laden des Moduls gelesen – genau wie vorher durch
  // Prisma selbst. Damit bleibt das Test-Muster gültig: src/testEnv.ts biegt die
  // Variable als Seiteneffekt-Import um, BEVOR dieses Modul den Client baut.
  // Bewusst KEIN Fail-fast an dieser Stelle: dieses Modul wird schon durch den
  // Import einer Datei geladen, die neben DB-Funktionen auch reine Hilfsfunktionen
  // exportiert (z. B. services/stepStatus.ts mit `deriveStepStatus`). Ein Wurf im
  // Modul-Scope wuerde deren Tests abbrechen, obwohl sie gar keine Datenbank
  // brauchen. Der Adapter verbindet – wie Prisma bis Version 6 – erst beim ersten
  // Query; die fehlende Variable meldet daher der Bootstrap (src/index.ts).
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" });

  const client = new PrismaClient({
    adapter,
    log: [{ emit: "event", level: "query" }],
  });

  client.$on("query", (e) => {
    if (e.duration > 5) {
      const query = e.query.length > 80 ? `${e.query.slice(0, 80)}…` : e.query;
      console.log(`${e.duration}ms ${query}`);
    }
  });

  return client;
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
