import "dotenv/config";
import { buildServer } from "./server.js";
import { startScheduler } from "./services/scheduler.js";

const PORT = Number(process.env.PORT ?? 3000);

// Standardmäßig NUR auf localhost lauschen. Das Backend spricht unverschlüsseltes
// HTTP; erreichbar sein muss es allein für den Proxy davor (Vite im Dev, IIS in
// Produktion) – der läuft auf derselben Maschine. Auf 0.0.0.0 gebunden wäre die
// API samt Bearer-Token im Klartext für jeden im Netz erreichbar und würde das
// HTTPS der beiden Apps umgehbar machen. HOST=0.0.0.0 öffnet es bewusst wieder.
// "localhost" statt "127.0.0.1": Fastify bindet damit alle Adressen, auf die
// localhost auflöst (IPv4 UND IPv6) – der Vite-Proxy verbindet sich sonst je
// nach Auflösungsreihenfolge auf ::1 und liefe ins Leere.
const HOST = process.env.HOST ?? "localhost";

// Fail-fast fuer die Datenbank-Adresse, gleiches Muster wie JWT_SECRET in
// server.ts. Seit Prisma 7 baut src/db.ts die Verbindung als Driver Adapter, und
// der verbindet erst beim ersten Query – ohne diese Pruefung starte der Server
// scheinbar normal und die erste Anfrage scheiterte mit einer pg-Meldung, die das
// eigentliche Problem (leere .env) nicht benennt.
function assertDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL fehlt in der .env – ohne Verbindungszeichenfolge kann der Server nicht arbeiten.",
    );
  }
}

async function main() {
  assertDatabaseUrl();
  // Der Ereignis-Verteiler läuft prozessintern (siehe events.ts) und
  // braucht keinen Verbindungsaufbau mehr – früher stand hier connectRedis().
  const app = buildServer();
  startScheduler();

  await app.listen({ port: PORT, host: HOST });
  console.log(`LagerHub backend läuft auf ${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
