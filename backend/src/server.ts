import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket, { type WebSocket } from "@fastify/websocket";
import jwt from "@fastify/jwt";
import { ZodError } from "zod";
import { subscribe } from "./events.js";

import { skillRoutes } from "./routes/skills.js";
import { employeeRoutes } from "./routes/employees.js";
import { taskRoutes } from "./routes/tasks.js";
import { stepRoutes } from "./routes/steps.js";
import { assignmentRoutes } from "./routes/assignments.js";
import { poolRoutes } from "./routes/pool.js";
import { statsRoutes } from "./routes/stats.js";
import { settingsRoutes } from "./routes/settings.js";
import { pushRoutes } from "./routes/push.js";
import { reminderRoutes } from "./routes/reminders.js";

// Zentrale Registry aller verbundenen WS-Clients. EIN Zuhörer am Ereignis-Bus
// verteilt an alle – statt pro Verbindung einen eigenen zu registrieren (das
// überschritt früher ab >10 Clients das Listener-Limit und ließ jede Nachricht
// durch N Handler laufen).
const clients = new Set<WebSocket>();

subscribe((message) => {
  for (const socket of clients) {
    if (socket.readyState === socket.OPEN) socket.send(message);
  }
});

export function buildServer() {
  const app = Fastify({
    // trustProxy: hinter dem Reverse-Proxy des Firmenservers spiegelt req.ip dann
    // die ECHTE Client-IP aus X-Forwarded-For (statt der Proxy-IP) – nötig, damit
    // der Login-Rate-Limiter pro echtem Client zählt, nicht alle über einen Kamm.
    // Setzt einen vertrauenswürdigen Proxy voraus (im Direktbetrieb ist der Header
    // fälschbar; im vorgesehenen Prod-Setup steht immer ein Proxy davor).
    trustProxy: true,
    // Im Test schweigen: sonst schiebt eine Handvoll inject()-Aufrufe eine Wand
    // aus Request-JSON durch die Testausgabe und verdeckt die Fehlermeldungen.
    logger: process.env.NODE_ENV === "test" ? false : {
      // Token NICHT ins Log schreiben: der WS-Handshake trägt das JWT im
      // Query-String (?token=…), und Fastify loggt die Request-URL. Ohne diese
      // Maskierung läge jedes Session-Token im Klartext im Server-Log.
      serializers: {
        req(req) {
          return {
            method: req.method,
            url: req.url.replace(/([?&]token=)[^&]+/gi, "$1[redacted]"),
            hostname: req.hostname,
            remoteAddress: req.ip,
          };
        },
      },
    },
  });

  // Einheitlicher Fehler-Handler:
  //  - Zod-Validierungsfehler → 400 (statt 500), damit ungültige Eingaben klar als
  //    Client-Fehler erscheinen.
  //  - Geworfene Fehler mit statusCode (404/409/403 aus den Routen) behalten ihren
  //    Code; die lesbare Meldung landet in { error } (beide Frontends lesen genau das).
  //  - Echte 5xx: Meldung NICHT nach außen geben (kein Stacktrace/Interna leaken),
  //    aber serverseitig loggen.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Ungültige Eingabe" });
    }
    // Fastify 5 typisiert den geworfenen Fehler als `unknown` – korrekt, denn
    // geworfen werden kann alles, nicht nur ein Error. Die beiden Felder, auf die
    // es hier ankommt, deshalb defensiv lesen statt den Typ wegzucasten.
    const e = err as { statusCode?: unknown; message?: unknown };
    const status = typeof e.statusCode === "number" ? e.statusCode : 500;
    if (status >= 500) {
      app.log.error(err);
      return reply.status(status).send({ error: "Interner Serverfehler" });
    }
    return reply
      .status(status)
      .send({ error: typeof e.message === "string" ? e.message : "Fehler" });
  });

  // CORS: in Prod läuft alles same-origin (Reverse-Proxy), da ist CORS irrelevant.
  // Für den direkten Cross-Origin-Zugriff lässt sich die Freigabe per CORS_ORIGIN
  // (kommagetrennt) einschränken; ohne Angabe spiegelt der Server jeden Origin
  // (Dev-Komfort).
  const corsOrigin = process.env.CORS_ORIGIN;
  if (!corsOrigin && process.env.NODE_ENV === "production") {
    app.log.warn(
      "[cors] CORS_ORIGIN ist in Produktion nicht gesetzt – der Server spiegelt JEDEN Origin. " +
        "Auf dem Firmenserver die erlaubten Origins in .env (CORS_ORIGIN) eintragen.",
    );
  }
  app.register(cors, {
    origin: corsOrigin ? corsOrigin.split(",").map((s) => s.trim()) : true,
  });
  app.register(websocket);

  // JWT-Auth: Secret ist Pflicht (Fail-fast – ohne Secret keine sichere Signatur).
  // Muss VOR den Routen registriert werden, damit request.jwtVerify/app.jwt.sign
  // in allen Route-Plugins (via Vererbung) bereitstehen. Laufzeit: 12 h (ein
  // Arbeitstag; per JWT_EXPIRES_IN übersteuerbar).
  const jwtSecret = process.env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error("JWT_SECRET fehlt in der .env – ohne Secret kann kein Token signiert werden.");
  }
  app.register(jwt, {
    secret: jwtSecret,
    sign: { expiresIn: process.env.JWT_EXPIRES_IN ?? "12h" },
  });

  // Abstand der Lebenszeichen. Muss deutlich unter dem Leerlauf-Zeitlimit des
  // Proxys liegen (IIS/ARR: 30 s Standard) – sonst faellt die Verbindung
  // regelmaessig, der Client verbindet zwar neu, aber jedes Loch ist ein
  // Zeitfenster, in dem Ereignisse verlorengehen.
  const HEARTBEAT_MS = 20_000;
  const alive = new WeakMap<object, boolean>();

  // WebSocket: leitet die Ereignisse an verbundene Clients weiter. Auth via Token im
  // Query-Param (?token=…), da ein Browser-WebSocket keinen Authorization-Header
  // setzen kann. Ohne gültiges Token wird die Verbindung sofort geschlossen (der
  // Kanal trägt u. a. MA-/Schritt-/Aufgabennamen – kein offener Mithörer).
  app.register(async (fastify) => {
    fastify.get("/ws", { websocket: true }, (socket, req) => {
      const token = (req.query as { token?: string }).token;
      try {
        if (!token) throw new Error("kein Token");
        fastify.jwt.verify(token);
      } catch {
        socket.close(1008, "Nicht angemeldet");
        return;
      }
      clients.add(socket);
      socket.on("close", () => clients.delete(socket));

      // Lebenszeichen: siehe HEARTBEAT_MS. Eine Antwort auf unseren Ping setzt
      // die Marke zurueck; bleibt sie aus, gilt die Verbindung als tot.
      alive.set(socket, true);
      socket.on("pong", () => alive.set(socket, true));
    });

    // Der Kanal ist die meiste Zeit still (Ereignisse kommen nur, wenn wirklich
    // etwas passiert). Ein Reverse-Proxy kappt eine untaetige Verbindung nach
    // seinem Leerlauf-Zeitlimit – bei IIS/ARR sind das standardmaessig Sekunden
    // im zweistelligen Bereich. Der Ping haelt sie offen und raeumt zugleich
    // halboffene Verbindungen ab, die sonst dauerhaft in `clients` blieben.
    const timer = setInterval(() => {
      for (const socket of clients) {
        if (alive.get(socket) === false) {
          alive.delete(socket);
          clients.delete(socket);
          socket.terminate();
          continue;
        }
        alive.set(socket, false);
        try {
          socket.ping();
        } catch {
          // Verbindung schon weg – der close-Handler raeumt auf.
        }
      }
    }, HEARTBEAT_MS);
    timer.unref?.();
    fastify.addHook("onClose", async () => clearInterval(timer));
  });

  app.register(skillRoutes, { prefix: "/api/skills" });
  app.register(employeeRoutes, { prefix: "/api/employees" });
  app.register(taskRoutes, { prefix: "/api/tasks" });
  app.register(stepRoutes, { prefix: "/api/steps" });
  app.register(assignmentRoutes, { prefix: "/api/assignments" });
  app.register(poolRoutes, { prefix: "/api/pool" });
  app.register(statsRoutes, { prefix: "/api/stats" });
  app.register(settingsRoutes, { prefix: "/api/settings" });
  app.register(pushRoutes, { prefix: "/api/push" });
  app.register(reminderRoutes, { prefix: "/api/reminders" });

  app.get("/health", async () => ({ ok: true }));

  return app;
}
