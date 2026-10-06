# LAGERHUB – Claude Code Projektanleitung

## Projektübersicht
**Warehouse Task Management System** – Echtzeit-Aufgabenverwaltung für Lagerteams.

- **Manager-Dashboard:** React + WebSockets (Echtzeit-Übersicht, Aufgaben, Statistik)
- **Mitarbeiter-App:** Progressive Web App (PWA) – mobiloptimiert, kein Offline-Modus

---

## Tech-Stack

| Schicht | Technologie |
|---|---|
| Backend | **Node.js 24 + Fastify 5** + @fastify/websocket 11 |
| Sprache | TypeScript 7 |
| Datenbank | **PostgreSQL 17, lokal** (Windows-Dienst `postgresql-x64-17`) |
| ORM | **Prisma 7** – Verbindung als **Driver Adapter** (`@prisma/adapter-pg`) in `src/db.ts`, Migrations-Verbindung in `prisma.config.ts`. `url`/`directUrl` sind im Schema NICHT erlaubt |
| Echtzeit-Verteilung | **Prozessinterner Ereignis-Bus** (`events.ts`, Node-`EventEmitter`), Kanal `lagerhub` |
| Validierung | zod 4 |
| Scheduler | node-cron 4 (bringt eigene Typen mit) |
| Auth | **JWT via `@fastify/jwt` 10** – zustandsloses Bearer-Token, `preHandler`-Rollen-Guards (`auth.ts`); kein DB-Session-Store |
| Push | **Web Push via VAPID** (`web-push`) |
| Tests | Vitest (`npm test`), Race-Tests gegen echte Test-DB `lagerhub_test` |
| Frontend (Manager-Dashboard) | **React 19 + Vite 8** (bundelt mit **Rolldown**), TanStack Query, nativer WebSocket (`/ws`), **Recharts**, **SheetJS (`xlsx`)** für den Excel-Export |
| Mobile (Mitarbeiter-App) | **PWA – eigene React-19-+-Vite-8-App (`pwa/`)**, `vite-plugin-pwa` 1.x (**injectManifest**, eigener `src/sw.ts`), TanStack Query, nativer WebSocket. Push braucht einen Secure Context (HTTPS/localhost) |

> ⚠️ **NICHT migrieren auf Express/Socket.io.** Server und Client-Registry sind auf Fastify gebaut und funktionieren.
> ⚠️ **Kein Redis.** Nicht wieder einführen, solange es nur einen Backend-Prozess gibt – bei zwei Prozessen dann aber zwingend (siehe Architektur).
> ⚠️ KEIN FastAPI, KEIN Python, KEIN SQLite, KEIN Firebase, keine Supabase.
> ⚠️ Frontend: **kein Redux/Zustand/MobX, kein Axios** – State über TanStack Query, Fetch über den Wrapper in `api/client.ts`. WebSocket ist nur Invalidierungs-Signal, kein Daten-/State-Kanal.

---

## Architektur-Grundsatz (Source of Truth)

```
Client → Fastify (/api) → 1. PostgreSQL schreiben (ggf. mit Zeilensperre)
                        → 2. publish() auf den Ereignis-Bus (Kanal "lagerhub")
                        → 3. /ws verteilt Event an alle verbundenen Clients
```

- **PostgreSQL gewinnt immer.** Jede zustandsändernde Aktion wird zuerst dort festgeschrieben.
- **Der Ereignis-Bus ist reiner Verteiler** (`src/events.ts`). Er hält keine Daten; fällt eine Zustellung aus, fehlt nur ein Live-Update, nie ein Datensatz. Zustellung per `setImmediate` (ein langsamer Empfänger hält den Request nicht auf) und `try/catch` je Empfänger (`emit` ist synchron – eine Ausnahme würde sonst den Prozess beenden).
- ⚠️ **Der Bus läuft prozessintern und trägt genau EINEN Backend-Prozess.** Bei zwei Instanzen bräuchte es einen echten Broker (Redis/Memurai) oder Postgres `LISTEN/NOTIFY`. Auszutauschen wäre allein `events.ts`; die `publish("lagerhub", …)`-Aufrufstellen bleiben unverändert.
- **Schritt-Status wird immer abgeleitet**, nie direkt gespeichert.

---

## Projektstruktur

```
C:\LagerHub
├── backend\
│   ├── prisma\           (migrations\, schema.prisma)
│   ├── src\
│   │   ├── routes\      (assignments, employees, pool, push, reminders, settings, skills,
│   │   │                  stats, steps, tasks)
│   │   ├── services\    (scheduler, stepStatus, stepAvailability, push, presence,
│   │   │                  crewmeister, quietHours, journalRetention, journalDuration,
│   │   │                  reminders, notes, …)
│   │   ├── scripts\     (backfill-worklog.ts, test-push.ts = Dev-Push-Auslöser,
│   │   │                  fix-orphaned-assignments.ts = Altlasten-Aufräumer,
│   │   │                  check-db.ts = Verbindungs-Diagnose (`npm run db:check`),
│   │   │                  setup-test-db.ts = `npm run db:test:setup`)
│   │   ├── auth.ts      (JWT-Guards: authAny/authDashboard/authManager/authAdmin)
│   │   ├── adminPins.ts, loginRateLimit.ts
│   │   ├── db.ts        (Prisma-Singleton + Query-Logging >5 ms)
│   │   ├── events.ts    (Ereignis-Bus: publish/subscribe, prozessintern)
│   │   ├── index.ts     (Bootstrap, Fail-fast für JWT_SECRET/DATABASE_URL)
│   │   ├── server.ts    (Fastify-Instanz, JWT, CORS, WS + Heartbeat, Routen, Error-Handler)
│   │   └── testDb.ts, testEnv.ts (Test-DB-Anbindung, aus dem Build ausgenommen)
│   ├── .env             (Secrets – nicht im Repo)
│   ├── .env.example, .env.production.example
│   ├── prisma.config.ts (Migrations-Verbindung, lädt die .env selbst – MUSS mit auf den Server)
│   └── tsconfig.json, tsconfig.build.json, vitest.config.ts
├── frontend\               (Manager-Dashboard)
│   ├── public\           (web.config für IIS, icon.svg)
│   └── src\
│       ├── api\          (client.ts, queries.ts, useRealtime.ts, session.ts, types.ts)
│       ├── tabs\         (PoolTab = „Dashboard", TasksTab, EmployeesTab, RemindersTab,
│       │                  StatsTab, HistoryTab, SettingsTab)
│       ├── components\   (AnalyticsSection, EmployeeDetailSection, JournalRunCard,
│       │                  NotesPanel, UtilizationGauge, Logo, KebabMenu, LoginScreen,
│       │                  StepAge, CompletionNotePrompt, ReminderBanner, ReminderJournal,
│       │                  useFloatingMenu.ts)
│       ├── lib\          (statsExport, chartColors, formatDuration, stepAge, useNow,
│       │                  reminderFormat)
│       ├── App.tsx, main.tsx, styles.css
│       └── vite-env.d.ts (Vite-Client-Typen; ohne sie bricht der Build unter TS 7)
├── pwa\                    (Mitarbeiter-App, Port 5174)
│   ├── public\           (web.config, icon.svg)
│   └── src\
│       ├── api\          (client.ts, queries.ts, useRealtime.ts, session.ts, push.ts, types.ts)
│       ├── components\   (LoginScreen, PoolList, NotesPanel, Notices, PushToggle,
│       │                  StepAge, CompletionNotePrompt, Logo)
│       ├── sw.ts         (Service Worker: Web-Push-Empfang; injectManifest, kein tsc)
│       └── App.tsx, main.tsx, styles.css
├── docs\                   (Serveruebergabe/Installationstag/IT-Abstimmung/Stick-Liesmich, HTML)
├── dev-certs.ps1           (Dev-CA + Zertifikat → certs\, gitignored)
├── start.ps1/.bat, stop.ps1/.bat
├── pack-stick.ps1          (Übergabe- bzw. Update-Paket)
├── update.ps1/.bat         (Update auf dem laufenden Server)
└── CLAUDE.md, README.md
```

---

## Umgebungsvariablen (.env)

```
# Lokale PostgreSQL 17 – beide URLs identisch
DATABASE_URL="postgresql://lagerhub:[PASSWORD]@localhost:5432/lagerhub"
DIRECT_URL="postgresql://lagerhub:[PASSWORD]@localhost:5432/lagerhub"
PORT=3000
#HOST=localhost              # Bind-Adresse, Default "localhost"

JWT_SECRET=""                 # PFLICHT (Fail-fast). Ändern = alle abgemeldet
JWT_EXPIRES_IN="12h"          # optional
CORS_ORIGIN=""                # optional, kommagetrennt; leer = jeden spiegeln (Dev)

VAPID_PUBLIC_KEY=""           # `npx web-push generate-vapid-keys`
VAPID_PRIVATE_KEY=""

# Geheime Admin-PINs (Rolle ADMIN, kein MA-Datensatz). Format "PIN:Name,…".
# Echte PINs NIE hier dokumentieren.
ADMIN_PINS="1234:Admin,5678:Chef"

# Crewmeister (Zeiterfassung), optional
CREWMEISTER_BASE_URL / CREWMEISTER_USER / CREWMEISTER_PASSWORD / CREWMEISTER_CREW_ID
```

- **Zugang:** Rolle + Datenbank `lagerhub`, nur `localhost`. Das `postgres`-Superuser-Passwort (Wartung, `pg_dump`) steht auskommentiert am Ende der `.env`. Auf dem Firmenserver gilt dieselbe Aufteilung (`backend/.env.production.example`).
- **`sslmode` entfällt** über Loopback. Wandert die DB je auf einen anderen Rechner, muss TLS zurück – dann als `verify-full` mit CA (`require` prüft kein Zertifikat).
- **Sonderzeichen im DB-Passwort URL-kodieren** (`encodeURIComponent`) – ein `@` beendet sonst den Passwort-Teil, die Verbindung läuft ins Leere, ohne dass die Zeile falsch aussieht. `npm run db:check` erkennt das.
- **Migrationen:** Verbindung kommt aus **`prisma.config.ts`** (`DIRECT_URL`, sonst `DATABASE_URL`), nicht aus dem Schema; die Prisma-CLI lädt die `.env` ab v7 nicht mehr selbst. Befehl am Installationstag: `npm run migrate:deploy`.
- **`.env` nicht mit `Get-Content`/`Set-Content` (PS 5.1) bearbeiten** – schreibt mit BOM bzw. liest UTF-8 als ANSI und zerschießt Umlaute.

---

## Lokales HTTPS (Entwicklung)

Beide Dev-Server laufen über **HTTPS** (`https://localhost:5173` / `:5174`), das Backend bleibt **HTTP auf `localhost:3000`** – dasselbe Bild wie in Produktion (IIS terminiert TLS und proxyt auf den lokalen Node-Prozess). Ohne Secure Context gibt es keinen Service Worker, also kein Push und keine PWA-Installation.

| Baustein | Wo |
|---|---|
| Zertifikat erzeugen | `dev-certs.ps1` → legt `certs/` an |
| Einbindung | `server.https` in beiden `vite.config.ts` (liest `../certs/`, ohne Zertifikat Rückfall auf http mit Warnung) |
| Aufruf | `start.ps1` erzeugt das Zertifikat automatisch, falls es fehlt |

- **Eigene Mini-CA** statt Einzelzertifikat: ein Handy installiert die CA **einmal** und vertraut danach jedem neu ausgestellten Zertifikat (z. B. nach IP-Wechsel). `dev-certs.ps1` erzeugt die CA nur einmal (`-Force` erzwingt neu, kostet das Vertrauen aller Geräte).
- **SANs** automatisch: `localhost`, Rechnername, `127.0.0.1`, `::1`, alle echten IPv4-Adressen (ohne APIPA).
- **Windows-Speicher per `certutil -user -addstore Root`** – `Import-Certificate` braucht für Root einen Dialog und scheitert ohne Oberfläche.
- **openssl über `Start-Process`** – in PS 5.1 macht umgeleitetes stderr einen `NativeCommandError`; außerdem zerlegt PS 5.1 Argument-Arrays an Leerzeichen.
- **Handy:** `certs/lagerhub-dev-ca.crt` einmal als **CA-Zertifikat** installieren (Android: Einstellungen → Sicherheit → Zertifikat installieren).
- **Backend bindet nur `localhost`** (`HOST`, per `.env` überschreibbar) – sonst wäre die Klartext-API samt Bearer-Token im Netz erreichbar und das HTTPS umgehbar. `"localhost"` statt `"127.0.0.1"`, damit IPv4 **und** IPv6 belegt sind (der Vite-Proxy verbindet je nach Auflösung auf `::1`).

---

## Auslieferung in Produktion (IIS)

IIS liefert die gebauten Frontends aus und terminiert TLS; das Backend ist derselbe Node-Prozess auf `localhost:3000` (als NSSM-Dienst). Zwei Websites, je ein interner Name, jede mit dem eigenen `dist/` als Wurzel. Das Prod-Zertifikat kommt per win-acme/DNS-01 (siehe Übergabe-Doku).

**Die `web.config` liegt in `public/`** – `vite build` kopiert sie mit, das Build-Ergebnis ist direkt das Website-Verzeichnis.

| Regel/Einstellung | Warum |
|---|---|
| Rewrite `^(api\|ws)(/.*)?$` → `localhost:3000` | **muss vor der SPA-Regel stehen**, sonst verschluckt diese `/api` |
| SPA-Fallback auf `index.html` | sonst 404 beim Neuladen einer Unterseite |
| `<webSocket enabled="true" />` | ohne das bleibt `/ws` **ohne Fehlermeldung** stumm |
| MIME `.webmanifest` / `.json` / `.svg` | IIS kennt sie nicht → 404 |
| `.html` = `DisableCache` | `index.html` verweist auf gehashte Dateinamen |
| PWA: `sw.js`/`registerSW.js`/`manifest.webmanifest` = `DisableCache` | der Service Worker bestimmt die Fassung auf dem Handy und trägt die Push-Behandlung |
| HSTS `max-age=31536000` | kein http-Betrieb. Kehrseite: abgelaufenes Zertifikat ist nicht wegklickbar – win-acme-Erneuerung muss laufen |

**Serverseitig, nicht in der `web.config`:** ARR-Proxy einschalten (sonst `/api` → 404), Windows-Feature „WebSocket Protocol", Zeitzone.

> ⚠️ **`X-Forwarded-For` am Einrichtungstag prüfen.** Fastify läuft mit `trustProxy: true`, `req.ip` kommt aus diesem Header. Fehlt er, sieht der Server jede Anfrage als `127.0.0.1` und der Login-Rate-Limiter (10/min **pro IP**) sperrt nach zehn Anmeldungen das ganze Haus. Dann in der Rewrite-Regel ergänzen und freischalten:
> `appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_FOR']" /commit:apphost` (ohne Freischaltung: **500.50**).

**WebSocket hinter dem Proxy:** ARR kappt untätige Verbindungen nach 30 s. Deshalb sendet `server.ts` alle 20 s einen Ping (`HEARTBEAT_MS`) und räumt nicht antwortende Sockets ab. Beide `useRealtime.ts` laden nach einem **Wieder**verbinden nach (der Bus wiederholt nichts); beim ersten Verbinden nicht (`reconnectedRef`).

**Produktions-`.env`** (Vorlage `backend/.env.production.example`): `NODE_ENV=production`, `TZ=Europe/Berlin` (Scheduler und Tagesgrenzen rechnen in Prozess-Lokalzeit), `HOST=localhost`, neues `JWT_SECRET`, neue `ADMIN_PINS`, `CORS_ORIGIN` = die beiden Website-Adressen.

### Übergabe-Paket (`pack-stick.ps1`)

Schnürt `LagerHub-Uebergabe-<Datum>\` plus ZIP (SHA256 daneben). `LagerHub\` wandert unverändert auf den Server, `backend\dist` als Dienst, `frontend\dist` und `pwa\dist` als IIS-Wurzeln. Einstieg für die IT ist `docs/Stick-Liesmich.html` (landet als `LIESMICH.html` in der Paketwurzel, die übrigen Dokumente unter `Doku\`).

| Entscheidung | Warum |
|---|---|
| **`backend\node_modules` liegt bei** (~550 MB) | Server braucht kein `registry.npmjs.org`: `npm ci`/`npm run build` entfallen, `prisma migrate deploy` läuft offline (Prisma-CLI ist `devDependency` – `--omit=dev` hätte sie weggelassen) |
| `frontend`/`pwa` nur als `dist` + Quellcode, ohne `node_modules` | Neubau ist Sache des Entwicklers, nicht der IT |
| Ausgeschlossen: **`.env*`** (Whitelist für die `.example`-Vorlagen), `certs\`, `.git\`, `.claude\` | Regel „alles Env-Artige raus, Vorlagen gezielt zurück" statt Aufzählung bekannter Namen (eine vergessene `.env.bak` rutschte sonst durch). Die Git-Historie enthält kompromittierte Alt-Admin-PINs |
| **Gegenprüfung nach dem Kopieren** (wirft und verwirft das Paket) | soll auch greifen, wenn jemand an der Kopierliste dreht. Prüft u. a. `@prisma/adapter-pg`, `pg` und `prisma.config.ts` |
| Installationsprogramme (Node, PostgreSQL, ARR, NSSM, win-acme) liegen **nicht** bei | gehören aus den geprüften Quellen der IT; `Stick-Liesmich.html` nennt Version und Bezugsquelle |
| **`backend\.env` liegt ausgefüllt bei** – `ADMIN_PINS`, VAPID-Schlüssel, Crewmeister-Zugang im Klartext, `JWT_SECRET` frisch gewürfelt (`-OhneAdminPins` schaltet die Vorbelegung ab) | Entscheidung des Betreibers: am Installationstag soll möglichst nichts einzutragen sein (leere DB → die Admin-PIN ist die einzige Tür). Preis: der Stick öffnet auch die Zeiterfassung. Werte kommen aus der lokalen `backend/.env`, **nie** aus dem Skript. Das Dev-`JWT_SECRET` wird **nicht** übernommen. Offen bleiben nur `DATABASE_URL`/`DIRECT_URL` (`[PASSWORT]`, vergibt die IT) und `CORS_ORIGIN`. Geschrieben **ohne BOM** und **zeilenweise statt per `[regex]::Replace`** (im .NET-Ersatztext ist `$` ein Sonderzeichen – ein Passwort mit Dollarzeichen wäre still zerschossen). Die Gegenprüfung erzwingt: keine Platzhalter bei Geheimnissen, `[PASSWORT]` noch in der DB-Adresse, Dev-`JWT_SECRET` nicht im Paket |

> ⚠️ **Am Server mit Paket vom Stick: kein `npm ci`, kein `npm install`, kein `npm run build`.** `npm ci` löscht `node_modules` zuerst und scheitert dann offline – danach startet nichts mehr. Prismas „Update available"-Hinweis ist **kein** Arbeitsauftrag. Bei Verbindungsproblemen: `npm run db:check` (prüft .env/BOM → URL → Port → Anmeldung → Schema und übersetzt SQLSTATE 28P01/3D000/28000/ECONNREFUSED in Klartext; gibt das Passwort nie aus).

### Update-Paket (`pack-stick.ps1 -Update` + `update.ps1`)

Für einen **bereits eingerichteten** Server: dasselbe Paket, aber **ohne `.env`** (die des Servers trägt DB-Kennwort und `JWT_SECRET`), ohne Einrichtungs-Doku, mit `update.bat`/`update.ps1` in der Paketwurzel. Auf dem Server: entpacken, `update.bat` als Administrator.

| Entscheidung | Warum |
|---|---|
| **`pg_dump` vor allem anderen**, Abbruch bei Fehler | scheitert es, ist noch nichts angefasst |
| Dienst wird **selbst gefunden** (NSSM-`AppDirectory` = `<Installation>\backend`), sonst `-Dienst` | Name wird erst am Installationstag vergeben |
| Backend-Teile werden **verschoben**, nicht kopiert | sofort und zugleich Sicherung für den Rückweg; ersetzt wird nur, was im Paket liegt |
| `frontend`/`pwa` `dist` per `robocopy /MIR` (vorher Kopie) | IIS hält Dateien offen, Verschieben scheitert |
| **Abweichende `web.config` bleibt**, neue als `web.config.neu` | Anpassungen der IT nicht still zurückdrehen |
| `db:check` + `migrate deploy` direkt über `node` | npm-`.cmd` scheitert aus Skripten unter neuerem Node |
| **Automatischer Rückweg** bei jedem Fehler ab dem Anhalten | alter Stand zurück, Dienst starten, `/health` prüfen; DB wird **nicht** automatisch zurückgespielt – das Fenster nennt den `pg_restore`-Befehl |
| Port für `/health` aus `PORT` der `.env` | statt fest 3000 |
| Sicherungen/Protokoll nach `C:\LagerHub-Sicherungen`, die letzten **drei** Programmstände bleiben | |

Geprüft gegen eine Probe-Installation (Gut- und Fehlerfall); **nicht** gegen einen echten NSSM-Dienst und IIS.

`npm run build` im Backend leert `dist` vorher (`prebuild`) – `tsc` löscht entfernte Dateien nie.

---

## Datenmodell (Prisma)

- **Skill** – globaler Katalog, Name eindeutig (= Schrittname 1:1)
- **Employee** – `pin` (4-stellig, eindeutig), `deviceId`, `deviceTrusted`, `role` (`MANAGER`/`OFFICE`/`WORKER` – steuert nur die Dashboard-Oberfläche, **nicht** die Einsetzbarkeit; ADMIN ist KEINE MA-Rolle), `present`/`presenceOverride`/`crewmeisterUserId` (Anwesenheits-Sync), `deletedAt` (Soft-Delete); n:m Skills via `EmployeeSkill`
- **Task** – `name` eindeutig, `priority` (HIGH/MEDIUM/LOW), `status` (OPEN/RUNNING/COMPLETED, abgeleitet), `poolEnabled`, `orderIndex` (Reihenfolge im Aufgaben-Tab; neue Aufgaben oben = kleinster Wert − 1), `repeat` (nach Abschluss sofort neuer Lauf im Pool), `startedAt`, `deletedAt` (Soft-Delete; Name wird freigegeben, TaskRun-Historie bleibt)
- **Step** – gehört zu Task; `minWorkers` (≥2 = Team), `maxWorkers`, `orderIndex`, `startedAt` (Timer-Start), **`availableAt`** (seit wann abholbar, siehe „Verfügbarkeits-Uhr"), `notes` (JSON, **append-only Notiz-Verlauf** des aktuellen Laufs: `[{ id, authorType: "MA"|"MANAGER"|"OFFICE"|"ADMIN", authorName, text, at, kind?, value?, label? }]`; wird in den TaskRun eingefroren und für den nächsten Lauf geleert), **`noteRequired`/`noteFormat` (`TEXT`|`NUMBER`)/`noteLabel`** (Pflichtnotiz); Vorgänger via `StepPredecessor`
- **Assignment** – ein MA an einem Schritt; `state` (OFFERED/ACTIVE/PAUSED/DONE/REJECTED), `pausedReason` (SWITCH/END_OF_DAY), `dayKey`. `OFFERED` belegt **keinen** Platz; `REJECTED` = Beleg für die Dashboard-Meldung. Status-Ableitung zählt nur ACTIVE/PAUSED/DONE. **Zeiten:** `startedAt`/`finishedAt`, `pausedAt` = Beginn des **offenen** Pausen-Intervalls, `pausedMs` = **kumulierte** abgeschlossene Pausen (`closePause` addiert das offene Intervall bei Resume/Complete/Snapshot), `switchCount` = Anzahl SWITCH-Unterbrechungen (Feierabend zählt nicht). **Netto-Arbeitszeit = `finishedAt − startedAt − pausedMs`.**
- **TaskRun** – Snapshot pro Durchlauf (`data` JSON: `steps[]` mit `name`, `startedAt`, `assignments` inkl. Zeiten, eingefrorene `notes`). Unveränderlich, **Ausnahme:** Admins/Manager dürfen Notizen **nachtragen** (`POST /stats/journal/:runId/notes`).
- **WorkLog** – **denormalisierte Auswertungs-Zeile** pro (MA, Schritt, Durchlauf), geschrieben in `finalizeTask`: `runId` (→ TaskRun, `onDelete: Cascade`), `employeeId`, `taskName`/`stepName`, `startedAt`/`finishedAt`, `activeMs` (Netto), `pausedMs`, `switchCount`. Indizes `(employeeId, finishedAt)` + `(finishedAt)`; Tagesgruppierung über `localDayKey`. Backfill: `npm run backfill:worklog` (idempotent, setzt `switchCount` nicht rückwirkend).
- **PushSubscription** – Web-Push-Abo pro Gerät; `employeeId`, `endpoint` (eindeutig → Upsert), `subscription` (JSON)
- **Reminder** – wiederkehrende Erinnerung, **tagesgenau**: `dueDate` (lokale Mitternacht), `repeatRule` (`NONE`/`DAILY`/`WEEKLY`/`MONTHLY`/`INTERVAL`) + `intervalDays`/`weekday`/`dayOfMonth`, `skillId` (nötig für „Pool"), `taskId` (wiederverwendete Pool-Aufgabe), `active`, `deletedAt`
- **ReminderEvent** – getroffene Entscheidung = Journal-Eintrag: `decision` (`DONE`/`POSTPONED`/`POOLED`/`OBSOLETE`), `decidedByName` (Text, kein FK – ADMIN hat keine MA-Zeile), `decidedById?`, `decidedAt`, `postponedTo?`, `reminderTitle` (Snapshot). Bewusst **keine** TaskRun-Zeile – zählt nicht als Arbeit.
- **Settings** – Singleton (`id = "singleton"`): `workStart`, `workEnd`, `escalationMins`, `breakStart`/`breakEnd` (gleiche Zeiten = keine Pause), `journalRetentionDays` (Default **0 = deaktiviert**)

Enums: `Priority`, `TaskStatus`, `AssignmentState`, `PausedReason`, `Role`

---

## Routen (`/api/*`)

> 🔒 Alle Routen sind per `preHandler`-Guard (`auth.ts`) rollengeschützt. Öffentlich sind nur `/employees/pin-login`, `/employees/login`, `/push/vapid-public-key`, `/health`.

| Route | Aufgabe |
|---|---|
| `skills.ts` | Liste + Upsert (keine Dubletten) |
| `employees.ts` | Liste mit Live-Status (`pin` nur für MANAGER/ADMIN), Anlegen (Auto-PIN via `crypto.randomInt`, keine reservierten Admin-PINs), **`/login`** (PWA: PIN + Device-Trust → MA + JWT), **`/pin-login`** (Dashboard: erkennt **vor** der MA-Suche eine Admin-PIN aus `ADMIN_PINS` → `role=ADMIN`), Geräte-Reset, Anwesenheit (`present`/`presenceOverride`, löst bei echtem Wechsel `handlePresenceTransition` aus), `/crewmeister-members`, **Soft-Delete** (gesperrt bei aktiver Zuweisung) |
| `tasks.ts` | CRU + **Soft-Delete** (gesperrt bei aktiver Zuweisung), Priorität (`TASK_PRIORITY_HIGH` bei „hoch"), **`POST /reorder`** (erwartet **alle** nicht gelöschten Aufgaben, sonst 409), `repeat`, Copy (übernimmt Pflichtnotiz-Felder), Restart. **Pool-Austritt** (`poolEnabled=false`) nur solange `task.startedAt === null` (sonst 409); löscht die Zuweisungen des Laufs in derselben Transaktion (`withdrawFromPool`), sendet `ASSIGNMENT_CHANGED` + je betroffener ACTIVE/PAUSED-Zuweisung `ASSIGNMENT_WITHDRAWN` + einen Push je MA |
| `steps.ts` | Anlegen (Skill-Upsert, Standard-Vorgänger = letzter Schritt), Update, Delete, **Reorder** (leert dabei „Wartet auf"), **Notiz anhängen** (`POST /:id/notes`, Autor aus dem Token → `STEP_NOTE_UPDATED`) |
| `assignments.ts` | **Kern-Logik:** atomares Einloggen (`FOR UPDATE`; Selbst-Login `POST /` nimmt `employeeId` aus dem Token, Body nur `stepId`), Auto-Unterbrechung, Team-Timer, Complete/Pause/Resume, `finalizeTask`. **Angebot:** `POST /offer` (Push an MA), `/:id/accept` (→ ACTIVE via `activateOnStep`), `/:id/reject` (→ REJECTED + `ASSIGNMENT_REJECTED`). **Anwesenheit** wird in `activateOnStep`, `/offer` und `/:id/resume` geprüft (409/404). **Team-Abschluss** erst ab `startedAt != null`, sonst 409. **Übernahme-Abschluss:** bei `maxWorkers === 1` schließt `complete` die noch PAUSED hängende Vorgänger-Zuweisung mit als DONE ab. **Pflichtnotiz:** `complete` nimmt `{ note? }`, 400 ohne gültigen Wert. **Erinnerung:** nach `complete` → `remindOwnInterruptedSteps`. **`/:id/leave`** löscht die eigene Zuweisung (keine Arbeitszeit), nur vor Timer-Start, sonst 409. **Besitzprüfung** `assertMayActOnAssignment`: WORKER nur eigene Zuweisungen, Dashboard-Rollen jede. `afterAssignmentChange` leitet alles aus **einem** `step.findMany` ab |
| `pool.ts` | Freigegebene Pool-Schritte (`poolEnabled`), gefiltert nach Skill/MA (**WORKER wird auf die eigene Identität gezwungen**). Liefert nicht gesperrte Schritte inkl. DONE (für Notizen); Aufgabe nur, wenn es offene Schritte gibt. **Eine** Abfrage mit `relationLoadStrategy: "join"`, Status in JS via `deriveStepStatus`. **`orderBy: [orderIndex, name]`** – beide Clients sortieren nur stabil nach Priorität, bei Gleichstand gilt die Reihenfolge aus dem Aufgaben-Tab |
| `stats.ts` | Tages-KPIs (`/`: `stepsCompletedToday` aus **TaskRun**, nicht aus `Task.status` – `finalizeTask` setzt die Aufgabe auf OPEN zurück), `/tasks-by-status`, **`/employee-load`** (Live-Auslastung: heutige WorkLogs + Live-Zuweisungen, `currentSince`/`activeBaseMs` für die mitlaufende Uhr), **`/journal`** (`?date=`; je Schritt `durationMinutes` + `workers[]` mit Netto-/Pausenminuten), `/journal/days`, `/journal/reminders`, `POST /journal/:runId/notes`, `DELETE /journal/:date` (authManager, nur Vergangenheit), `/history`, **`/employee-history`** + **`/throughput`** (Zeitraum, Default 7 Tage), **`/step-durations`** (nur ADMIN, gruppiert nach **(taskName, stepName)**, Netto pro Person), **`/employee-detail`** (nur ADMIN, inkl. inaktiver Zeit) |
| `settings.ts` | **Lesen `authAny`** (PWA braucht `escalationMins` für die Alters-Ampel), **Schreiben `authAdmin`**. `TimeString` prüft echte Uhrzeiten; „Ende nach Beginn" wird gegen den Stand **nach dem Merge** geprüft (ein PATCH darf einzelne Felder schicken). Pause `start == end` erlaubt (= aus). Geänderte `journalRetentionDays` räumen sofort per `purgeOldJournals()` auf |
| `reminders.ts` | Liste, **`GET /due`** (Banner), Anlegen/Ändern/Soft-Delete (**authManager**), **`POST /:id/decide`** (**authDashboard**) schreibt `ReminderEvent` + nächsten Termin in **einer** Transaktion; `POOLED` erzeugt/weckt die Pool-Aufgabe |
| `push.ts` | VAPID-Public-Key (public), `/subscribe` (Upsert per endpoint, `employeeId` aus dem Token), `/unsubscribe` (nur eigenes Abo) |

**Querschnitt in `server.ts`:** Error-Handler (`ZodError` → 400, geworfene `statusCode` bleiben, 5xx-Text wird nicht geleakt – Antwort immer `{ error }`), `?token=` wird im Request-Log maskiert, `trustProxy: true`, CORS-Warnung bei `NODE_ENV=production` ohne `CORS_ORIGIN`, Logger unter `NODE_ENV=test` aus. **Login-Rate-Limit** (`loginRateLimit.ts`): 10 Versuche/min/IP → 429 + `Retry-After`; der preHandler **muss `async` sein**, sonst hängt der Request.

## Services

- **`stepStatus.ts`** – leitet Schritt-Status (LOCKED/OPEN/**WAITING**/ACTIVE/PAUSED/DONE) und Aufgaben-Status ab. **WAITING** = Team-Schritt besetzt, aber `minWorkers` noch nicht erreicht. Reine `deriveStepStatus(step)` + `stepStatusSelect`; `computeTaskStatus` holt alles in **einer** Abfrage. ⚠️ `deriveStepStatus` kennt `poolEnabled` **nicht** – ein Schritt einer nicht gestarteten Aufgabe gilt dort als OPEN.
- **`scheduler.ts`** – minütlicher Tick: Feierabend-Pause und Arbeitsbeginn-Erinnerung (**nur** für MA ohne Zeiterfassung, `notClockManagedFilter()`; ohne Crewmeister-Konfiguration für alle), Journal-Aufräumlauf um `RETENTION_PURGE_TIME = "03:00"` **plus einmal beim Serverstart**, Eskalation (Referenz `Step.availableAt`, `null` = nie eskalieren). Uhrzeitregeln laufen über `isExactMinute()` – eine verpasste Minute fällt ersatzlos aus.
- **`quietHours.ts`** – `isWithinQuietPeriod({ breakStart, breakEnd }, now?)`, **pur** (bekommt die Settings vom Scheduler übergeben, `now` injizierbar). Alles, was „keine Pause" bedeutet (gleiche Zeiten, Ende vor Beginn, unparsbar), lässt den Alarm **durchlaufen** – ein stumm gewordener Alarm wäre der teurere Fehler.
- **`stepAvailability.ts`** – pflegt `Step.availableAt`: `markAvailableSteps(taskId)`, `markStepAvailable(stepId)`, `clearAvailability(taskId)`. **Nur setzen, nie überschreiben** (`availableAt: null`-Guard).
- **`journalRetention.ts`** – `purgeOldJournals()`: löscht TaskRuns vor dem Stichtag (WorkLogs per Cascade, ReminderEvents mit), sendet **ein** Sammel-`JOURNAL_DELETED` (`reason: "retention"`). Bei `0` passiert nichts.
- **`journalDuration.ts`** – Schritt-Dauer fürs Tagesjournal: Team-Zeit **einmal** (Abschnitte vereinigt), Unterbrechungen raus, Wartezeit vor dem Team-Timer raus.
- **`notes.ts`** – `asNoteArray` (Schranke gegen kaputtes JSON: defekte Einträge verwerfen statt den ganzen Verlauf), `makeNoteEntry`, `noteAuthorFromUser` (Name + Rolle aus dem Token), `validateCompletionNote`/`makeCompletionNote` (Pflichtnotiz).
- **`push.ts`** – Web Push, best effort: `sendPushToEmployees`, `notifyReleasedStep`, `notifyHighPriorityTask`, `notifyAssignmentOffer`. **Empfänger** (Regel 1/2 + Eskalation): qualifizierte MA, die **nicht schon auf einer HIGH-Aufgabe** aktiv sind. Fehlende Keys/Sendefehler scheitern nie einen Request; 404/410-Abos werden aufgeräumt.
- **`crewmeister.ts`** – Client der Zeiterfassung (v3-API, JWT-Cache mit Refresh bei 401): `getPresentUserIds()` (`stampStatus==OPEN`, Pausen = anwesend), `getWorkingMinutes(from,to,userId?)` (nur `WORKING_TIME`, > 24 h/Tag gekappt), `getMembers()`. `crewmeisterConfigured()`; Fehler als `CrewmeisterError`. **Alles Anbieter-Spezifische steckt nur hier** (Ausnahme: Feld-/Routennamen `crewmeisterUserId`, `/employees/crewmeister-members`).
- **`presence.ts`** – minütlicher Anwesenheits-Sync aus Crewmeister, nur für MA im Auto-Modus (`presenceOverride == null`) mit `crewmeisterUserId`. Reagiert auf den **Wechsel** via `handlePresenceTransition` (siehe Kernregel „Anwesenheit"). Importiert `afterAssignmentChange`/`remindOwnInterruptedSteps` aus `routes/assignments.ts` (bewusst kein Nachbau).
- **`reminders.ts`** – reine Terminrechnung der Erinnerungen.

### Inaktive Zeit (MA-Detail-Auswertung)

```
inaktiv(Tag) = max(0, Crewmeister-WORKING_TIME(Tag) − Σ WorkLog.activeMs(Tag))
```

- **Netto gegen Netto:** die Mittagspause zählt bewusst nicht als inaktiv.
- Die Pro-Tag-Tabelle listet die **Vereinigung** aus Tagen mit erledigten Schritten und Tagen mit Stempelzeit (> 0 min) – ein Stempeltag ohne fertigen Schritt erscheint als voller Leerlauf.
- **Grenze:** WorkLog entsteht erst bei Abschluss der **ganzen Aufgabe** – für „heute" ist die Kennzahl systematisch zu hoch. Zuordnung über `finishedAt` (Mitternachts-Überlauf unbehandelt).
- Ohne Crewmeister-Zuordnung/-Erreichbarkeit sind die Inaktiv-Felder `null` (Anzeige „–" + Grund).

---

## Design / Farbwelt (Branding)

Gemeinsame Palette als CSS-Variablen in `frontend/src/styles.css` **und** `pwa/src/styles.css`:

- **Navy `#212C3D`** (`--brand` im Dashboard, `--accent` in der PWA) = Grundton: Kopfbalken/Topbar, Primär-Buttons, aktiver Tab-Text, Haupttext.
- **Gold `#EEC643`** (`--accent` im Dashboard, `--gold` in der PWA) = Akzent: aktive Tab-Unterlinie, Kopf-Akzentlinie, PWA-Angebots-Karte.
- Semantik-Farben (Priorität/Status, Anwesenheit, Fortschritt, Info) bleiben bewusst eigenständig.

> **Nie Gold-Text auf Weiß** (Kontrast < AA). Gold nur als Fläche/Linie mit **Navy**-Text (`--on-accent`). Navy trägt weißen Text.

**Tokens** (gleiche Struktur in beiden Apps): `--r-sm/md/lg`, `--sh-xs/sm/md(/lg)`, `--ring`, `--hover`, `--border-strong`. **Prinzip: Tiefe über weiche Schatten statt harter Rahmen.**

- **Kopf/Topbar** mit Navy-Verlauf + Schatten; PWA-Topbar `sticky`. Aktiver Tab = Gold-Balken via `::after`.
- **Tabellen:** Versalien-Köpfe, Zeilen-Hover, `tabular-nums` (auch in `.kpi__value`). Abgerundete Ecken über `border-collapse: separate` + `border-spacing: 0` + `overflow: hidden` – gilt global.
- **Bedienelemente:** einheitlicher Rahmen/Radius, `:focus-visible`-Ring, Druckpunkt. **Checkbox/Radio vom Feld-Styling ausgenommen** (`input:not([type="checkbox"]):not([type="radio"])`).
- **Badges** als weiche Pillen mit `box-shadow: inset 0 0 0 1px`.
- **Karten-Staffelung:** `.task-card` (beide Apps) trägt `--border-strong` + `--sh-md`, `.card` bleibt bei `--border` + `--sh-xs`; Abstand zwischen Aufgaben 20 px, zwischen Schritten 12 px; Seitenhintergrund `--bg: #e9edf3`. **Kontrast und Nähe staffeln die Ebenen.** `.card` nicht mit anheben (sonst Schattenwand in der Statistik).
- **Fluchten statt `space-between`:** `.row` nur für Zeilen mit festem Inhalt. `.row--start` hält Elemente links gepackt. **Grid**, wenn Angaben über mehrere Zeilen untereinander stehen sollen (`.journal-run__head`, `.assignees`); Namensspalten als `max-content`, Badges in Grid-Zellen mit `justify-self: start`. Buttons mit wechselnder Beschriftung bekommen `min-width`.
- **Aufklappende Menüs in Tabellen gehören in ein Portal** – das `overflow: hidden` der Tabelle klippt sonst jedes Dropdown. `components/useFloatingMenu.ts`: `createPortal` an `<body>`, `fixed`, Umklappen nach oben, Fensterrand-Klemmung, Reposition bei resize/scroll (capture), Schließen bei Außenklick (Auslöser **und** Portal-Inhalt prüfen)/Escape, vor der ersten Messung `visibility: hidden`. CSS-Modifier `.menu__dropdown--float`; `.menu__dropdown` **nicht** global auf `fixed` stellen. Genutzt von `KebabMenu`, `SkillMultiSelect`, `SkillSelect`.
- **Excel-Buttons (`.btn--excel`):** grün `#14804a`, weißer Text, linksbündig, `min-width: 220px`, Beschriftung `⬇ Excel: <Was>` (Zeitraum im `title`); deaktiviert weiß.
- `@media (prefers-reduced-motion: reduce)` schaltet Übergänge ab.

### Diagramm-Farben (`lib/chartColors.ts`)

Marken-Farben taugen nicht direkt als Datenflächen (Navy zu dunkel/zu wenig Chroma, Gold 1.6:1 auf Weiß). Abgeleitete Stufen mit gleichem Farbton:

| Slot | Marke | Datenfarbe |
|---|---|---|
| 1 | Navy | `#2c5aa0` |
| 2 | Gold | `#a4861c` |

Reihenfolge fest. Alle Diagramme haben **eine** Datenreihe (Slot 1), Titel statt Legende. Balken mit 4 px gerundeten Enden, Linien 2 px mit 8-px-Markern, Gitter nur waagerecht in `--border`, Achsen ohne Linien in `--muted`. **Kein Diagramm mit zwei y-Achsen.** Der Auslastungstacho nutzt Navy/Grün/Amber als **Hex** (CSS-Variablen greifen in SVG-Attributen nicht).

**Logo** (`components/Logo.tsx`, beide Apps): Inline-SVG – isometrischer Würfel + „Lager**Hub**", zweite Zeile „by Andinsky". Farben als Hex. Gleiches Mark als Favicon/App-Icon (`public/icon.svg`, `theme_color` Navy `#212c3d`).

---

## Frontend (Manager-Dashboard)

Sieben Tabs (`TabId`/`TAB_ACCESS` in `api/session.ts`): **Dashboard** (`PoolTab.tsx`), **Aufgaben**, **Mitarbeiter**, **Erinnerungen**, **Statistik**, **Historie**, **Einstellungen**. Header zeigt den Live-Verbindungsstatus.

- **Dashboard (`tabs/PoolTab.tsx`)** – oben `ReminderBanner` (fällige Erinnerungen) und der **Auslastungstacho**, darunter drei Bereiche nach **`task.startedAt`** (nicht nach abgeleitetem Status): **In Bearbeitung**, **Offen – noch nicht begonnen** (mit „Aus Pool entfernen"; sind MA eingeloggt, erst eine Inline-Bestätigung mit Namen – kein `confirm()`), **Tagesjournal** (`JournalRunCard` + `ReminderJournal`). Sortierung nach Priorität (stabil), Prioritäts-Badge je Karte. Je Schritt: freien, **anwesenden**, qualifizierten MA einsetzen (Angebot); voll besetzt (ACTIVE ≥ `maxWorkers`) → „● voll besetzt (n/n)". Je Bereich die ersten **3** Einträge mit fester Reservehöhe + „▾ Alle anzeigen"; Karten eingeklappt. Notiz-Spalte `📝` je Schritt; DONE-Schritte des laufenden Laufs bleiben sichtbar (für Notizen). Banner für `ASSIGNMENT_REJECTED` (gelb) und `WORK_REMINDER` (blau).
- **`components/UtilizationGauge.tsx`** – SVG-Halbkreis, rechnet rein im Frontend aus `pool` + `employees`: Personalauslastung, Schritt-Besetzung, „sofort besetzbar" vs. „Engpass". Jede Kennzahl ist ein Button, der die passende Detailliste aufklappt.
- **Aufgaben (`tabs/TasksTab.tsx`)** – Anlegen/Bearbeiten, Kopieren/Löschen. **Aufgaben per Drag & Drop am Griff ⠿** sortieren (optimistisch, `useReorderTasks`); Schritte ebenfalls nur per Drag & Drop. Fähigkeit über `SkillSelect` (Einfachauswahl mit Suche + „Neu anlegen" – **der Skill-Upsert-Weg muss erhalten bleiben**). **Schritt bearbeiten** öffnet eine Box über die volle Tabellenbreite (Raster `Beschriftung | Feld`, Pflichtnotiz als letzte Zeile; „Wartet auf" als `.check-list`). **„Starten"** = `poolEnabled=true` + `restart`, mit Inline-Bestätigung als Leiste unter dem Kopf; im Pool stattdessen „● im Pool". Kartenkopf: Steuerblock mit festen Breiten, damit Felder über alle Karten fluchten.
- **Mitarbeiter (`tabs/EmployeesTab.tsx`)** – Liste, Anlegen, Fähigkeiten (`SkillMultiSelect`), Anwesenheits-Schalter, Crewmeister-Zuordnung (Dropdown zeigt nur aktive Mitglieder; ein zugeordnetes, inzwischen deaktiviertes bleibt als Option), Kebab-Menü.
- **Erinnerungen (`tabs/RemindersTab.tsx`)** – Anlegen/Pflegen für MANAGER/ADMIN; OFFICE sieht den Tab, darf aber nur entscheiden.
- **Statistik (`tabs/StatsTab.tsx`, nur ADMIN)** – KPIs, Live-Auslastung mit mitlaufender Uhr (`useNow`-Sekundentakt, `formatClock`), Excel „Tagesübersicht" + „Mitarbeiter-Auslastung". Darunter `AnalyticsSection` und `EmployeeDetailSection`.
- **`components/AnalyticsSection.tsx`** – Von/Bis + „Suchen" (Default 7 Tage), MA-Tabelle, einklappbare **„Ø Zeit je Arbeitsschritt"** (`StepDurationsSection`, Dropdown „Aufgabe", Tabelle + Balkendiagramm), Diagramme als einzeln aufklappbare Liste (aktive Zeit je MA, Schritte je MA, Ø Dauer je Aufgabentyp). `/throughput` speist nur noch das Excel-Blatt. **Excel (`lib/statsExport.ts`):** „Alle" → 4 Blätter; einzelner MA → Detail-Mappe (5 Blätter). Zeitraum im Dateinamen.
- **Historie (`tabs/HistoryTab.tsx`)** – eigener Tab, damit **OFFICE** die Tagesjournale sieht ohne die Statistik. Tage aus `/stats/journal/days`, aufklappbar; Default die **letzten 5** Tage (`JOURNAL_DAYS_LIMIT`), ältere über Von/Bis, die **erst auf „Suchen"** greift. Notizen nachtragen; Tag löschen nur für Manager/Admin (an `isManager` gebunden – Route ist `authManager`).
- **Einstellungen (`tabs/SettingsTab.tsx`, nur ADMIN)** – vier Karten mit **je eigenem Speichern**: Arbeitszeiten, Eskalation, Pause, Automatische Löschung. Fehler nur an der auslösenden Karte. **`key={JSON.stringify(settings)}`** auf `SettingsForms`, damit ein fremder Stand per `SETTINGS_UPDATED` die Entwürfe neu aufbaut. Jede Karte erklärt die Wirkung im Klartext.
- **`components/JournalRunCard.tsx`** – gemeinsame Tagesjournal-Darstellung (Dashboard **und** Historie). Baum Aufgabe → Schritte (mit `durationMinutes`) → `workers` (`Name · 25 min`, Unterbrechungsdauer bewusst nicht). Kopfzeit = **Summe der gerundeten Schritt-Dauern** (geht beim Aufklappen genau auf; nicht die Wanduhr). Kopf als Raster `.journal-run__head`. Notizen je Schritt hinter `📝`. Statistik-KPI „Ø Dauer" und `/throughput` rechnen weiter Wanduhr.
- **`components/NotesPanel.tsx`** – Notiz-Verlauf (`Zeit · Name (MA/Manager/Büro/Admin): Text`) + Eingabe (Strg+Enter). `kind: "COMPLETION"` fett mit Beschriftung.
- **`components/CompletionNotePrompt.tsx`** – Eingabe der Pflichtnotiz (Kopie in beiden Apps). `isCompletionNoteValid` muss dasselbe akzeptieren wie `validateCompletionNote` im Backend.
- **`components/StepAge.tsx` + `lib/stepAge.ts`** – „⏱ 42 min", in **beiden** Apps als Kopie mit **gleichen Regeln**:
  - **Alter statt Uhrzeit**, exakter Zeitpunkt im `title`.
  - **Ampel aus `Settings.escalationMins`** (`< 50 %` grau, `50–100 %` amber, `≥ 100 %` rot) – derselbe Schwellwert wie der Eskalations-Push.
  - **Bezugspunkt je Status** (`stepAgeBasis`): OPEN/WAITING → `availableAt` mit Ampel; ACTIVE/PAUSED → `startedAt` ohne Ampel; DONE/LOCKED → nichts.
  - **`formatAge()`** (ab einem Tag `9 d 2 h`), nicht `formatMinutes()`.
  - **Ein Takt pro Seite** (`lib/useNow.ts`, 30 s).
- **`lib/formatDuration.ts` – `formatMinutes()`**: einzige Stelle für Zeitspannen-Anzeige (`45 min`, `1 h 16 min`, `2 h`, `–`). **Gerechnet und übertragen wird in ganzen Minuten**; der **Excel-Export schreibt blanke Minuten** – nicht auf „1 h 16 min" umstellen. Kein Dezimalstunden-Format. Diagramm-Achsen in Minuten, nur Tooltips formatiert (`minutesTooltip`).
- **`api/client.ts`** – Fetch-Wrapper auf relative `/api`-URLs, hängt `Authorization: Bearer …` an, 401 → Session verwerfen → Login; behandelt 204.
- **`api/queries.ts`** – zentrale `queryKeys` + Hooks. Mutations invalidieren ihre Keys, **außer** die Assignment-Mutationen (offer/accept/reject/pause/resume/complete) – das übernimmt das WS-Event. Statistik-Keys mit Prefix `stats`.
- **`api/useRealtime.ts`** – WebSocket `/ws?token=…` (nur angemeldet, Auto-Reconnect 2 s). Event → `EVENT_MAP` → Invalidierung, gebündelt im **200-ms-Fenster** (`scheduleInvalidate`). Nichts wird aus dem Payload in den State gepatcht.

---

## PWA (Mitarbeiter-App)

Eigenständige React-19-+-Vite-8-App unter `pwa/` (Port 5174), mobile-first, teilt **keinen** Code mit dem Dashboard. Dev-Server proxyt `/api` + `/ws` selbst.

- **Login (`LoginScreen.tsx`, `api/session.ts`):** PIN + **Gerätebindung** (`POST /employees/login`, `deviceId` in `localStorage`). PIN als Passwortfeld. `deviceId` per `generateUuid()` (`crypto.randomUUID` nur im Secure Context, sonst `getRandomValues`-Fallback).
- **Arbeitsansicht (`PoolList.tsx`):** Schritte aus `/api/pool`, gruppiert in **„Meine Arbeit"** (aktive oben, unterbrochene darunter, Kartenakzent grün/gelb) und **„Verfügbare Aufgaben"** (`classifyTask`); je Block nach Priorität sortiert, Prioritäts-Badge. Aktionen: Einloggen, Abschließen, Unterbrechen, Fortsetzen; bei WAITING-Team-Schritt stattdessen **„Ausloggen"** (`/leave`). Voll besetzt → Hinweis statt Einloggen. Alter „⏱" rechts vor der Notiz-Schaltfläche.
- **Pflichtnotiz:** Knopf heißt `Abschließen 📝` und klappt `CompletionNotePrompt` gold umrandet **unter der Zeile** auf (bewusst kein Modal – verdeckt die Zeile, Tastatur schiebt es weg). Zahl-Felder mit `inputMode="decimal"` statt `type="number"` (sonst kein Komma).
- **Angebote + Notizen:** annehmen/ablehnen, MA-Notizen (`NotesPanel`, Autor aus dem Token).
- **Meldungen (`Notices.tsx`):** über den Roh-Event-Verteiler `onRealtimeEvent`, gefiltert auf die eigene `employeeId`: `WORK_REMINDER` (blau) und `ASSIGNMENT_WITHDRAWN` (amber `.reminder--withdrawn`). Ein Banner je `kind:stepId`.
- **`api/useRealtime.ts`:** WS-Signal → invalidiert `pool` (200-ms-Bündelung) + `onRealtimeEvent`-Verteiler. Assignment-Mutationen ohne Self-Invalidate.
- **Web-Push (`src/sw.ts`, `api/push.ts`, `PushToggle.tsx`):** injectManifest, eigener SW mit `push`/`notificationclick` (aus dem tsc-Typecheck ausgenommen, `workbox-precaching` für die App-Shell). `PushToggle` fragt Berechtigung an (Nutzer-Geste), abonniert mit VAPID-Key, meldet an `/push/subscribe`, beim Abmelden wird das Abo entfernt. Dev-Test: `npm run test:push -- <MA-Name>` (Backend).
- **Ton** kann die App nicht bestimmen (Android-Kanal von Chrome, Nutzer-Einstellung); beeinflussbar ist nur `vibrate` in `showNotification`. „Bitte nicht stören" unterdrückt beides.

---

## Kernregeln (Geschäftslogik)

### Rollen & Dashboard-Zugang

Dashboard-Login per 4-stelliger PIN (`/pin-login`), PWA per PIN + Gerätebindung (`/employees/login`). Beide liefern ein **JWT** (`{ sub, role, name }`, 12 h), gehalten in `localStorage` und bei jeder Anfrage als Bearer mitgeschickt. `TAB_ACCESS` ist reiner Komfort – die echte Absicherung sind die Server-Guards.

| Rolle | Tabs | Zugang |
|---|---|---|
| **ADMIN** | alle sieben | **geheime PIN** aus `ADMIN_PINS` (kein MA-Datensatz) |
| **MANAGER** | Dashboard, Aufgaben, Mitarbeiter, Erinnerungen, Historie | MA mit `role=MANAGER` |
| **OFFICE** (Büro) | Dashboard, Aufgaben, Erinnerungen (nur entscheiden), Historie | MA mit `role=OFFICE` |
| **WORKER** (Lager) | — (PWA) | MA mit `role=WORKER` |

ADMIN ist **keine** MA-Rolle (Prisma-`Role` = MANAGER/OFFICE/WORKER), existiert nur als Token-Rolle (`AuthRole`). `adminPins.ts` parst `ADMIN_PINS` lazy (PIN-Wechsel erst nach Neustart); leeres/fehlendes `ADMIN_PINS` ⇒ kein Admin. Reservierte Admin-PINs werden nie an MA vergeben.

### Auth & Autorisierung (`auth.ts`)

Guards als `preHandler`: **`authAny`**, **`authDashboard`** (OFFICE/MANAGER/ADMIN), **`authManager`** (MANAGER/ADMIN), **`authAdmin`** – 401 ohne/ungültiges Token, 403 bei falscher Rolle. **Identität kommt aus dem Token, nie aus Body/Query** (`POST /assignments`, `/push/subscribe`, Notiz-Autor, `GET /pool` für WORKER). **WS** verlangt `?token=…` (Browser-WS kann keinen Header setzen), ungültig → Close **1008**. Token-Widerruf vor Ablauf gibt es nicht (zustandslos) – Mitigation: 12-h-Laufzeit + Secret-Wechsel.

### Vorgänger-Logik
Ein Schritt ist freigegeben, wenn **alle** Vorgänger DONE sind, sonst LOCKED. Gesperrte Schritte erscheinen nicht im Pool. Neuer Schritt erhält standardmäßig den letzten Schritt als Vorgänger.

### Verfügbarkeits-Uhr (`Step.availableAt`)

Der Freigabe-Zeitpunkt ist aus `Assignment`-Zeiten nicht rekonstruierbar – deshalb eine eigene Spalte, gepflegt ausschließlich über `services/stepAvailability.ts`:

| Ereignis | Wirkung |
|---|---|
| Aufgabe kommt in den Pool (`poolEnabled` false→true, `restart`) | `markAvailableSteps` stempelt die jetzt offenen Schritte |
| Letzter Vorgänger fertig (`handleStepUnlocks`) | `markStepAvailable` für diesen Nachfolger |
| Abschluss (`finalizeTask`) / Neustart | zurück auf `null`; bei `repeat` direkt neu stempeln |
| Aufgabe verlässt den Pool | `clearAvailability` |

**Reihenfolge:** „Starten" ist `PATCH poolEnabled=true` **+** `restart` – `restart` stempelt **nach** seinem eigenen Zurücksetzen. Nutzer der Spalte: Anzeige (`StepAge`) und Eskalation (`null` = nicht eskalieren).

### Team vs. Einzel
- **Team (min ≥ 2):** Timer (`Step.startedAt`) startet erst bei `min` qualifizierten MA; einer schließt für alle ab. Vorher Status **WAITING** (Aufgabe bleibt unter „Offen"). `complete` vor Start → **409**.
- **Einzel (min leer/1):** jeder loggt sich selbst ein und schließt die eigene Zuweisung ab; Schritt DONE, wenn die letzte aktive Zuweisung fertig ist. Bei `maxWorkers === 1` schließt der Übernehmer die unterbrochene Vorgänger-Zuweisung mit ab.

### Team-Schritt vor Beginn verlassen
`POST /assignments/:id/leave` löscht die eigene Zuweisung (Platz frei, keine Arbeitszeit) – nur solange der Timer nicht läuft; atomar via `FOR UPDATE`.

### Aufgaben-Abschluss
`finalizeTask` (in `assignments.ts`): schreibt TaskRun + WorkLogs, löscht die Lauf-Zuweisungen, setzt Schritt-Timer zurück, Aufgabe auf OPEN. **Standard:** `poolEnabled=false` – kein Auto-Neustart, neuer Lauf über „Starten". **`task.repeat`:** bleibt im Pool, sofort neuer Lauf + `TASK_RESTARTED`.

### Pool-Austritt
Nur solange kein Schritt begonnen wurde (`task.startedAt === null`, sonst 409). Die Zuweisungen werden **gelöscht** (nicht PAUSED – es lief kein Timer), offene Angebote gehen mit. Betroffene MA bekommen `ASSIGNMENT_WITHDRAWN` + einen Push. **Grenze:** ein Login genau zwischen Guard und Transaktion kann verwaisen (`activateOnStep` sperrt die Step-Zeile, nicht die Aufgabe) – dafür `npm run fix:orphans` (Default Testlauf, `-- --apply` löscht nur verlustfreie Fälle).

### Race Condition
Prüfen + Belegen atomar via `FOR UPDATE`. Abgelehnte MA: „Schritt gerade voll (z. B. 3/3)".

**Eine Zuweisung je (MA, Schritt):** unter derselben Sperre prüft `activateOnStep`, ob der MA auf diesem Schritt schon `OFFERED`/`ACTIVE`/`PAUSED` hat → **409** (vor der Kapazitätsprüfung). `DONE`/`REJECTED` ausgenommen, beim Annehmen das eigene Angebot (`promoteAssignmentId`). Ohne die Prüfung entstanden doppelte Zuweisungen (z. B. unterbrechen, dann „Einloggen" statt „Fortsetzen" – PAUSED zählt nicht zur Kapazität) und damit doppelte WorkLog-Zeilen. Kein DB-Unique-Index, weil Prisma partielle Indizes nicht im Schema abbildet.

### Anwesenheit
Nur **anwesende** MA (`present=true`, nicht gelöscht) dürfen arbeiten – geprüft in `activateOnStep`, `POST /offer` und `POST /:id/resume`, jeweils für den **MA der Zuweisung**.

**`handlePresenceTransition(employeeId, nowPresent)`** (`services/presence.ts`) bei echtem Wechsel, ausgelöst vom Stempel-Sync **und** vom manuellen Schalter:

| Übergang | Folge |
|---|---|
| abwesend (`true → false`) | alle ACTIVE → PAUSED, `END_OF_DAY`, `pausedAt = jetzt`, dann `afterAssignmentChange` je Schritt. `switchCount` wird **nicht** erhöht |
| anwesend (`false → true`) | `remindOwnInterruptedSteps` → `WORK_REMINDER` + Push je unterbrochenem Schritt |

**Manuell schlägt Stempel:** ein gepinnter MA (`presenceOverride != null`) wird vom Sync nicht angefasst. Zurück auf Auto rechnet die Route neu; ein daraus folgender Wechsel wird vom Sync behandelt. **Warum zwingend:** ohne Unterbrechung beim Ausstempeln würde die ganze Nacht als Arbeitszeit gebucht. Grenzen: Minutentakt (bis 60 s Versatz); fällt Crewmeister aus, greift die Uhrzeit-Regel des Schedulers. Fehler je MA in `try/catch`.

### Pflichtnotiz beim Abschluss (`Step.noteRequired`)

Konfiguration je Schritt: `noteRequired`, `noteFormat` (Freitext/Zahl), `noteLabel`. **Die Angabe ist Teil der Abschluss-Aktion** (`complete` mit `{ note? }`, sonst 400) – nicht „irgendeine Notiz am Schritt", sonst erfüllte eine alte Notiz die Pflicht.

| Entscheidung | Warum |
|---|---|
| Guard im **Backend** | Dashboard-Rollen dürfen fremde Zuweisungen abschließen |
| Notiz in **derselben Transaktion** wie `state: "DONE"` | Angabe darf nicht verloren gehen |
| **Eine** Angabe je Team-Schritt (auch beim Übernahme-Abschluss) | Menge ist Eigenschaft des Schritts |
| Deutsches **Komma** erlaubt (`42,5`) | Handy-Zifferntastatur; Backend und beide Clients akzeptieren dasselbe |
| `label` wird im Eintrag mitgespeichert | Snapshot zeigt, wonach damals gefragt wurde |

Eintrag mit `kind: "COMPLETION"` (bei `NUMBER` zusätzlich `value`), landet über `finalizeTask` im Tagesjournal. `kind`/`value`/`label` sind optional (Altbestand). **Grenze:** der Wert steht nicht im WorkLog – keine „Ø Menge"-Auswertung.

### Unterbrechen / Wechseln
> UI-Begriff **„Unterbrechung"**; intern bleiben `PAUSED`/`pausedAt`/`pausedMs`/`closePause`.

Login auf Schritt B während aktiv auf A → A automatisch unterbrochen (`SWITCH`, `switchCount + 1`). Wird der Platz durch Ersatz aufgefüllt → ursprüngliche Zuweisung aufgelöst. Schließt ein MA einen Schritt ab und hat noch unterbrochene offen → `WORK_REMINDER` + Push (nicht zeitbasiert).

### Push (nur bei „hoch")
1. Aufgabe wird „hoch" **oder** eine hochpriore Aufgabe wird gestartet (`poolEnabled` false→true) → `notifyHighPriorityTask()` für alle offenen Schritte – **nur wenn die Aufgabe im Pool ist** (`deriveStepStatus` kennt `poolEnabled` nicht). `TASK_PRIORITY_HIGH` als Dashboard-Event bleibt ungefiltert.
2. Vorgänger-Abschluss gibt Schritt frei → `STEP_UNLOCKED`, bei hoher Priorität `notifyReleasedStep()`.

Empfänger: qualifizierte MA, die nicht schon auf einer HIGH-Aufgabe aktiv sind.

### Eskalation
Offener Schritt einer HIGH-Aufgabe länger als `escalationMins` seit `availableAt` → `ESCALATION` an Manager + Push an qualifizierte MA. Nur in Arbeitszeit. **Wiederholt sich jede Minute** (absichtlich), bis am Schritt eine ACTIVE/PAUSED-Zuweisung hängt (`hasActive`-Guard, **je Schritt**). **Pause** (`breakStart`–`breakEnd`, Default 12:00–12:30): Eskalation schweigt, danach geht sie weiter; Beginn einschließlich, Ende ausschließlich. Die einmaligen Pushs kommen auch in der Pause durch. Nur **ein** Pausenfenster.

### Aufbewahrung der Tagesjournale (`Settings.journalRetentionDays`)

Pflege im **Einstellungen-Tab** (ADMIN).

| Entscheidung | Warum |
|---|---|
| **Default `0` = deaktiviert** | Löschen ist unumkehrbar – der Betrieb muss bewusst setzen |
| Stichtag = **lokale Mitternacht** heute − N Tage | gleiche Tagesgrenze wie „heute"/`localDayKey` |
| Löschen über **TaskRun** | WorkLogs folgen per Cascade |
| **Ein** Sammel-`JOURNAL_DELETED` | Clients invalidieren ohnehin den ganzen `stats`-Prefix |
| `PATCH /settings` räumt sofort auf | Wirkung soll direkt sichtbar sein |

Auslöser: Scheduler 03:00 + Serverstart + PATCH; idempotent. **Grenze:** mit dem Lauf verschwindet auch seine Auswertung; einen Aggregat-Restbestand gibt es nicht.

### Erinnerungen (`Reminder`)

Wiederkehrende Dinge (Wartung, Prüfung, Bestellung); angelegt im Erinnerungen-Tab, entschieden im **Banner im Dashboard**. **Tagesgenau:** fällig ist `dueDate <= heute` – deshalb **kein Scheduler** (eine verpasste Minute kann nichts verschlucken), und nichts verschwindet von selbst (Überfälliges rot mit „seit N Tagen").

| Knopf | Wirkung | Nächster Termin |
|---|---|---|
| **Erledigt** | fertig | nach Takt |
| **Verschieben** | 1–7 Tage (`MAX_POSTPONE_DAYS`) | genau in N Tagen; Takt unberührt |
| **Pool** | wird zum Arbeitsschritt | nach Takt |
| **Hinfällig** | diesmal nicht nötig | nach Takt |

- Takt zählt ab dem **Entscheidungstag** (keine rückwirkende Flut).
- `NONE` wird nach der Entscheidung **inaktiv** („Abgeschlossen", nachlesbar).
- Monatlich am 31. → **Monatsletzter**; wöchentlich am heutigen Wochentag → **eine ganze Woche** weiter.
- **„Pool" erzeugt eine echte Aufgabe** mit einem Schritt (Fähigkeit der Erinnerung), die beim ersten Mal entsteht und danach **wiederverwendet** wird (`Reminder.taskId`). Ohne Fähigkeit ist „Pool" gesperrt (400).
- **Journal:** Entscheidungen als eigene Zeilen (`ReminderJournal.tsx`) aus `GET /stats/journal/reminders` (nicht `/journal`). `/journal/days` zählt sie mit, `DELETE /journal/:date` und `purgeOldJournals` räumen sie mit weg.
- Grenzen: keine Feiertage, keine Uhrzeit, Sonntage werden nicht übersprungen.

---

## Echtzeit-Events (Kanal `lagerhub`)

`SKILL_CREATED`, `EMPLOYEE_CREATED`, `EMPLOYEE_UPDATED`, `EMPLOYEE_DEVICE_RESET`, `EMPLOYEE_DELETED`,
`TASK_CREATED`, `TASK_UPDATED`, `TASK_PRIORITY_HIGH`, `TASK_COMPLETED`, `TASK_RESTARTED`, `TASK_DELETED`,
`TASKS_REORDERED`, `STEP_CREATED`, `STEP_UPDATED`, `STEP_DELETED`, `STEP_TIMER_STARTED`, `STEP_UNLOCKED`, `STEPS_REORDERED`, `STEP_NOTE_UPDATED`,
`ASSIGNMENT_CHANGED`, `ASSIGNMENT_OFFERED`, `ASSIGNMENT_REJECTED`, `ASSIGNMENT_WITHDRAWN`, `TEAM_UNDERSTAFFED`,
`JOURNAL_UPDATED`, `JOURNAL_DELETED`, `REMINDER_UPDATED`,
`END_OF_DAY`, `WORK_REMINDER`, `ESCALATION`, `SETTINGS_UPDATED`

`JOURNAL_DELETED` hat zwei Auslöser: manuelles Löschen (mit `date`) und Aufbewahrung (`reason: "retention"` + `days`).

---

## Tests

Vitest (`npm test` / `npm run test:watch`), 13 Testdateien: reine Services (`stepStatus`, `computeTaskStatus` mit gemocktem Prisma, `crewmeister`, `quietHours`, `presence`, `stepAvailability`, `notes`, `reminders`, `journalDuration`), Zugang (`auth`, `adminPins`, `loginRateLimit`) und **`routes/assignments.race.test.ts` gegen echte PostgreSQL**.

- **Test-DB:** `npm run db:test:setup` legt `lagerhub_test` an und spielt die Migrationen ein. **Nach jeder neuen Migration erneut ausführen**, sonst „column does not exist". `testDb.ts` leitet die URL aus `DATABASE_URL` ab; `testEnv.ts` biegt `DATABASE_URL` als Seiteneffekt-Import um, **bevor** `db.ts` lädt. Vor jedem Test `TRUNCATE` aller Tabellen außer `_prisma_migrations`. Fehlt die Test-DB, überspringt sich die Datei (`ctx.skip()`).
- **Race-Tests brauchen einen aufgewärmten Pool** (`beforeAll` öffnet zehn Verbindungen parallel) – sonst serialisieren sich die Anfragen von allein und der Test bleibt auch ohne `FOR UPDATE` grün. Gegenprobe gegen den kaputten Zustand wurde gemacht.
- **Nicht abgedeckt:** die dicken Routen (`assignments.ts`, `stats.ts`) jenseits der Race-Tests, `journalRetention.ts` (Stichtag-Off-by-one), beide Frontends (kein Runner).

---

## Offene Punkte

- [ ] **Einrichtungstag am Firmenserver:** `X-Forwarded-For` hinter ARR prüfen, WebSocket durch ARR am echten IIS, Update-Paket gegen echten NSSM-Dienst + IIS. Ursache der fehlgeschlagenen DB-Verbindung beim ersten Termin ist nicht belegt – beim nächsten Versuch zuerst `npm run db:check`.
- [ ] **Push nach `vite-plugin-pwa` 1.x** am echten Handy noch nicht erneut gemessen (SW enthält die Handler).
- [ ] **Alt-Admin-PINs gelten als kompromittiert** (lagen früher im versionierten `adminPins.ts`) – nur neue `ADMIN_PINS` verwenden.
- [ ] **`POST /offer`** prüft „eine Zuweisung je (MA, Schritt)" ohne Sperre – zwei gleichzeitige Angebote möglich (geringe Folgen).
- [ ] **Tests:** siehe „Nicht abgedeckt".
- [ ] **Token-Widerruf** vor Ablauf nicht möglich (siehe Auth).

---

## Hinweise für Claude Code

- **Fastify NICHT umbauen.** Kein Express, kein Socket.io. `events.ts` ist die einzige Stelle, an der die Verteilung ausgetauscht werden darf.
- Reihenfolge jeder Aktion: 1. PostgreSQL → 2. `publish()` → 3. /ws verteilt.
- Schritt-Status immer ableiten (`stepStatus.ts`), nie direkt schreiben. Für mehrere Schritte gebündelt holen (`stepStatusSelect` + `deriveStepStatus`), kein N+1.
- Bei gleichzeitigen Zuweisungen immer `FOR UPDATE`.
- **Auth:** jede neue `/api`-Route braucht einen Guard aus `auth.ts`. **Identität NIE aus Body/Query, sondern aus `req.user.sub`/`req.user.role`.**
- **Frontend:** State über TanStack Query, kein Store, kein Axios. Neue Backend-Events ggf. in `EVENT_MAP` (`useRealtime.ts`) ergänzen. Mutationen, deren Backend ohnehin ein WS-Event sendet, invalidieren nicht zusätzlich selbst.
- **Reads mit verschachtelten `include`s:** `relationLoadStrategy: "join"` setzen. `relationJoins` ist auch in Prisma 7 noch **Preview** – aus `previewFeatures` entfernt, verschwindet `relationLoadStrategy` aus den Typen und Prisma fällt still auf Multi-SELECT zurück.
- **Prisma-Upgrades:** vorher `npm view prisma dist-tags` prüfen – `latest` zeigte schon auf einen Release Candidate.
- **Fail-fast gehört in `index.ts`**, nicht ins DB-Modul (sonst brechen Tests, die `db.ts` nur indirekt laden).
- Migrationen lesen ihre Verbindung aus **`prisma.config.ts`**; neue DB-Umgebungsvariablen gehören dorthin UND in `src/db.ts`.
- Prisma-CLI/tsx aus Skripten **direkt über `process.execPath`** starten – Node 24 startet `.cmd` ohne Shell nicht (`spawnSync … EINVAL`).
- `.env` niemals in Antworten oder Logs ausgeben; nicht mit PS-5.1-`Get-Content`/`Set-Content` bearbeiten.
- Änderungen gehören in diese Datei als **Ist-Zustand**, nicht als Changelog – die Historie steht in git.
