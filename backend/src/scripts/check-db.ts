/**
 * Diagnose der Datenbank-Verbindung - fuer den Installationstag.
 *
 * Aufruf: npm run db:check
 *
 * Beantwortet die Frage "warum kommt keine Verbindung zustande?" in EINEM
 * Durchlauf und benennt die Ursache im Klartext, statt eine rohe pg-Meldung
 * durchzureichen. Geprueft wird in der Reihenfolge, in der es schiefgeht:
 * .env lesbar -> URL zerlegbar -> Server erreichbar -> Anmeldung -> Schema.
 *
 * Das Passwort wird nie ausgegeben.
 */
import "dotenv/config";
import { readFileSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { Client } from "pg";

const rot = (t: string) => "\u001b[31m" + t + "\u001b[0m";
const gruen = (t: string) => "\u001b[32m" + t + "\u001b[0m";
const gelb = (t: string) => "\u001b[33m" + t + "\u001b[0m";

let fehler = 0;
const ok = (t: string) => console.log("  " + gruen("OK") + "      " + t);
const warn = (t: string) => console.log("  " + gelb("HINWEIS") + " " + t);
const bad = (t: string, hilfe?: string) => {
  fehler++;
  console.log("  " + rot("FEHLER") + "  " + t);
  if (hilfe) for (const z of hilfe.split("\n")) console.log("          " + z);
};

// --- 1. Konfigurationsdatei -------------------------------------------------
console.log("\n1. Konfigurationsdatei");
if (!existsSync(".env")) {
  bad(".env fehlt im Ordner backend", "Vorlage kopieren:  copy .env.production.example .env");
} else {
  const roh = readFileSync(".env");
  // Ein BOM verkraftet dotenv selbst (nachgeprueft mit dotenv 18: DATABASE_URL
  // wird trotzdem gelesen). Es bleibt aber ein Warnsignal, denn es heisst, dass
  // die Datei mit einem Werkzeug geschrieben wurde, das UTF-8 mit BOM erzeugt -
  // PowerShell 5.1 mit `Set-Content -Encoding utf8` tut genau das. Im Projekt
  // hat das schon einmal die Umlaute in den Kommentaren zerlegt. Deshalb
  // Hinweis statt Fehler: nicht die Ursache, aber ein guter Verdacht.
  if (roh[0] === 0xef && roh[1] === 0xbb && roh[2] === 0xbf) {
    warn(".env beginnt mit einem BOM (Byte Order Mark)");
    console.log("          dotenv kommt damit klar, andere Werkzeuge nicht zwingend.");
    console.log("          Sauber: als UTF-8 OHNE BOM neu speichern (Notepad++:");
    console.log("          Kodierung -> UTF-8 ohne BOM). NICHT mit Set-Content schreiben.");
  } else {
    ok(".env vorhanden, kein BOM");
  }
}

// --- 2. Verbindungszeichenfolge --------------------------------------------
console.log("\n2. Verbindungszeichenfolge");
const roheUrl = process.env.DATABASE_URL;
type Cfg = { host: string; port: number; user: string; password: string; database: string };
let cfg: Cfg | null = null;

if (!roheUrl) {
  bad("DATABASE_URL ist nicht gesetzt", "In der .env eintragen (Etappe 4 der Installationsanleitung).");
} else if (roheUrl.includes("[PASSWORD]") || roheUrl.includes("[PASSWORT]")) {
  bad(
    "DATABASE_URL enthaelt noch den Platzhalter [PASSWORD]",
    "Das Passwort aus Etappe 3 (CREATE USER) eintragen.",
  );
} else {
  // Der Klassiker zuerst: ein unkodiertes Sonderzeichen zerlegt die URL, ohne
  // sie ungueltig zu machen. Aus "pa@ss" wird ein Host namens "ss" - die
  // Verbindung geht dann ins Leere, ohne dass die Zeile falsch aussieht.
  const rest = roheUrl.slice(roheUrl.indexOf("://") + 3);
  const trenner = rest.lastIndexOf("@");
  const vorAt = trenner >= 0 ? rest.slice(0, trenner) : "";
  const verdacht = vorAt.split(":").length > 2 || vorAt.includes("@");
  const kodierHilfe =
    "Zeichen wie @ : / ? # % & muessen in der URL kodiert werden:\n" +
    "  @ -> %40    : -> %3A    / -> %2F    # -> %23    % -> %25\n" +
    "Kodierten Wert erzeugen (Passwort als Argument, erscheint nicht in der Datei):\n" +
    "  node -e \"console.log(encodeURIComponent(process.argv[1]))\" DEIN_PASSWORT\n" +
    "Alternative: dem Benutzer ein Passwort ohne Sonderzeichen geben.";

  try {
    const u = new URL(roheUrl);
    cfg = {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
    };
    ok(
      "zerlegt: Host " + cfg.host + ", Port " + cfg.port +
        ", Benutzer " + cfg.user + ", Datenbank " + cfg.database,
    );

    if (verdacht) bad("Das Passwort enthaelt vermutlich unkodierte Sonderzeichen", kodierHilfe);
    if (!cfg.database) bad("In der URL steht kein Datenbankname", "Erwartet wird  .../lagerhub  am Ende.");
    if (cfg.password === "") bad("Das Passwort in der URL ist leer");
    if (cfg.host !== "localhost" && cfg.host !== "127.0.0.1") {
      warn("Host ist " + cfg.host + " - laut Einrichtung sollte die Datenbank auf localhost liegen");
    }
  } catch {
    bad(
      "DATABASE_URL laesst sich nicht als URL lesen",
      "Erwartetes Format:\n  postgresql://BENUTZER:PASSWORT@localhost:5432/lagerhub\n" +
        (verdacht ? kodierHilfe : ""),
    );
  }
}

// DIRECT_URL liest ab Prisma 7 die prisma.config.ts fuer die Migrationen.
if (roheUrl && !process.env.DIRECT_URL) {
  warn("DIRECT_URL ist nicht gesetzt - prisma.config.ts nutzt dann DATABASE_URL (lokal in Ordnung)");
}

/** Reiner TCP-Test: lauscht auf Host/Port ueberhaupt etwas? */
function portOffen(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = createConnection({ host, port });
    const fertig = (v: boolean) => {
      s.destroy();
      res(v);
    };
    s.setTimeout(4000);
    s.on("connect", () => fertig(true));
    s.on("timeout", () => fertig(false));
    s.on("error", () => fertig(false));
  });
}

async function main() {
  if (cfg) {
    // --- 3. Erreichbarkeit ---------------------------------------------------
    console.log("\n3. Erreichbarkeit");
    if (await portOffen(cfg.host, cfg.port)) {
      ok(cfg.host + ":" + cfg.port + " nimmt Verbindungen an");
    } else {
      bad(
        "Auf " + cfg.host + ":" + cfg.port + " antwortet nichts",
        "Laeuft der Dienst?  Get-Service postgresql*\n" +
          "Falls gestoppt:     Start-Service postgresql-x64-17\n" +
          "Abweichender Port?  In postgresql.conf nachsehen und die .env anpassen.",
      );
    }

    // --- 4. Anmeldung --------------------------------------------------------
    console.log("\n4. Anmeldung");
    const client = new Client({ ...cfg, connectionTimeoutMillis: 6000 });
    try {
      await client.connect();
      ok("Anmeldung als " + cfg.user + " an Datenbank " + cfg.database + " erfolgreich");

      const t = await client.query<{ n: string }>(
        "SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'public'",
      );
      console.log("\n5. Schema");
      const namen = t.rows.map((r) => r.n);
      if (namen.length === 0) {
        warn("Die Datenbank ist leer - die Tabellen fehlen noch");
        console.log("          Vor Etappe 5 normal. Anlegen mit:  npm run migrate:deploy");
      } else if (namen.includes("_prisma_migrations")) {
        ok(namen.length + " Tabellen vorhanden (Migrationen eingespielt)");
      } else {
        warn(namen.length + " Tabellen, aber keine _prisma_migrations - fremdes Schema?");
      }
      await client.end();
    } catch (e: unknown) {
      const m = e as { code?: string; message?: string };
      const code = m.code ?? "";
      if (code === "28P01") {
        bad(
          "Passwort oder Benutzer stimmt nicht (28P01)",
          "Das Passwort in der .env weicht von dem aus CREATE USER ab.\n" +
            "Neu setzen mit psql:  ALTER USER lagerhub WITH PASSWORD '...';\n" +
            "Enthaelt es Sonderzeichen, muss es in der URL kodiert werden (Punkt 2).",
        );
      } else if (code === "3D000") {
        bad(
          "Die Datenbank " + cfg.database + " existiert nicht (3D000)",
          "Anlegen mit psql:  CREATE DATABASE lagerhub OWNER lagerhub;",
        );
      } else if (code === "28000") {
        bad(
          "Die Anmeldung ist in pg_hba.conf nicht erlaubt (28000)",
          "Dort eine Zeile fuer localhost mit Methode scram-sha-256 vorsehen,\n" +
            "danach:  Restart-Service postgresql-x64-17",
        );
      } else if (code === "ECONNREFUSED") {
        bad("Verbindung abgelehnt", "Der Dienst laeuft nicht - siehe Punkt 3.");
      } else {
        bad("Verbindung fehlgeschlagen" + (code ? " (" + code + ")" : "") + ": " + (m.message ?? String(e)));
      }
      try {
        await client.end();
      } catch {
        /* Verbindung war nie offen - nichts zu schliessen */
      }
    }
  }

  console.log("");
  console.log(
    fehler === 0
      ? gruen("  Ergebnis: Die Datenbank-Verbindung steht.")
      : rot("  Ergebnis: " + fehler + " Punkt(e) zu klaeren - siehe oben."),
  );
  console.log("");
  process.exit(fehler === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
