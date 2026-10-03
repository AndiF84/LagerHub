// Schlanker In-Memory-Rate-Limiter für die Login-Routen (PIN-Login der PWA und
// Dashboard-PIN-Login). Eine 4-stellige PIN hat nur 10 000 Kombinationen – ohne
// Bremse rät ein Skript sie in Minuten durch. Hier: pro Client-IP höchstens
// MAX_ATTEMPTS Versuche je WINDOW; danach 429 mit Retry-After.
//
// Bewusst dependency-frei und pro-Instanz (ein Server, wie die WS-Client-Registry).
// Für den vorgesehenen Einzel-Server-Betrieb ausreichend; bei mehreren Instanzen
// müsste der Zähler in einen gemeinsamen Speicher wandern. req.ip stimmt nur mit trustProxy (server.ts)
// hinter dem Reverse-Proxy – dort steht die echte Client-IP.
import type { FastifyReply, FastifyRequest } from "fastify";

const WINDOW_MS = 60_000; // 1 Minute
const MAX_ATTEMPTS = 10; // pro IP und Fenster

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// MUSS async sein (gibt ein Promise zurück): Fastify ruft preHandler-Hooks mit
// (req, reply, done) auf. Eine SYNCHRONE Funktion, die weder ein Promise
// zurückgibt noch done() aufruft, lässt den Request ewig hängen. Die Guards in
// auth.ts sind aus demselben Grund async.
export async function loginRateLimit(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const now = Date.now();
  const ip = req.ip;
  const bucket = buckets.get(ip);

  if (!bucket || now > bucket.resetAt) {
    // Neues Fenster (auch: abgelaufenes überschreiben → verhindert unbegrenztes
    // Wachsen der Map, alte Einträge werden bei nächstem Zugriff derselben IP ersetzt).
    buckets.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  bucket.count++;
  if (bucket.count > MAX_ATTEMPTS) {
    const retrySec = Math.ceil((bucket.resetAt - now) / 1000);
    // Retry-After setzen und den Lifecycle SAUBER abbrechen: throw (statt bare
    // reply.send() im Hook, das den Handler weiterlaufen ließe → Doppelantwort).
    // Der zentrale Error-Handler (server.ts) macht daraus 429 { error }.
    reply.header("Retry-After", String(retrySec));
    throw Object.assign(
      new Error(`Zu viele Login-Versuche. Bitte ${retrySec} Sekunden warten.`),
      { statusCode: 429 },
    );
  }
}
