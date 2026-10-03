# LAGERHUB – Claude Code Projektanleitung

## Projektübersicht
**Warehouse Task Management System** – Echtzeit-Aufgabenverwaltung für Lagerteams.

- **Manager-Dashboard:** React + WebSockets (Echtzeit-Übersicht, Aufgaben, Statistik)
- **Mitarbeiter-App:** Progressive Web App (PWA) – mobiloptimiert, kein Offline-Modus

---

## Tech-Stack (IST-Zustand – so ist der Code gebaut)

| Schicht | Technologie |
|---|---|
| Backend | **Node.js 24 + Fastify 5** + @fastify/websocket 11 |
| Sprache | TypeScript 7 (native Neuimplementierung; lief ohne Codeanpassung durch) |
| Datenbank | **PostgreSQL 17, lokal** (Windows-Dienst `postgresql-x64-17`) – früher Supabase-Cloud |
| ORM | **Prisma 7** – Verbindung als **Driver Adapter** (`@prisma/adapter-pg`) in `src/db.ts`, Migrations-Verbindung in `prisma.config.ts`. `url`/`directUrl` sind im Schema NICHT mehr erlaubt |
| Echtzeit-Verteilung | **Prozessinterner Ereignis-Bus** (`events.ts`, Node-`EventEmitter`), Kanal `lagerhub` – früher Redis Pub/Sub |
| Validierung | zod 4 |
| Scheduler | node-cron 4 (bringt eigene Typen mit – `@types/node-cron` ist entfernt) |
| Auth | **JWT via `@fastify/jwt` (v10, Fastify-5-kompatibel)** – zustandsloses Bearer-Token, `preHandler`-Rollen-Guards (`auth.ts`); kein DB-Session-Store |
| Push | **Web Push via VAPID** (`web-push`) – ersetzt firebase-admin (Backend fertig) |
| Frontend (Manager-Dashboard) | **React 19 + Vite 8** (Vite 8 bundelt mit **Rolldown** statt Rollup), TanStack Query, nativer WebSocket (`/ws`), **Recharts** (Diagramme in der Auswertung), **SheetJS (`xlsx`)** (Excel-Export der Statistiken) |
| Mobile (Mitarbeiter-App) | **PWA – eigene React-19-+-Vite-8-App (`pwa/`)**, `vite-plugin-pwa` 1.x (**injectManifest**, eigener `src/sw.ts`), TanStack Query, nativer WebSocket. Arbeitsansicht (M2), Angebote/Notizen (M3), **Web-Push-Empfang (M4, Service Worker + `PushManager.subscribe`)**. Push braucht HTTPS/localhost (Secure Context) – lokal ist das seit der Dev-HTTPS-Umstellung auch über die LAN-IP gegeben. |

> ⚠️ **NICHT migrieren auf Express/Socket.io.** Der gesamte Server, die Client-Registry
> und die Client-Registry sind auf Fastify gebaut und funktionieren.
> ⚠️ **Redis ist bewusst entfernt** (Umzug auf Windows Server, siehe unten). Nicht
> wieder einführen, ohne dass es zwei Backend-Prozesse gibt – dann aber zwingend.
> ⚠️ KEIN FastAPI, KEIN Python, KEIN SQLite.
> ⚠️ KEIN Firebase. `firebase-admin` ist entfernt, `web-push` ist installiert; die Push-
> *Logik* ist im **Backend** (`services/push.ts`) **und** die PWA-Empfangsseite (Service Worker
> `pwa/src/sw.ts` + Abo, M4) sind **fertig** und end-to-end verifiziert. Push funktioniert nur im
> **Secure Context** (HTTPS/localhost). Der Dev-Betrieb läuft deshalb über HTTPS – siehe
> Abschnitt „Lokales HTTPS (Entwicklung)".
> ⚠️ Frontend: **kein Redux/Zustand/MobX, kein Axios** – State läuft über TanStack Query, Fetch über den schlanken Wrapper in `api/client.ts`. WebSocket dient nur als Invalidierungs-Signal, nicht als Daten-/State-Kanal.
> ℹ️ **Supabase ist raus** (seit 07.09.2026). Die Datenbank läuft lokal; die alten
> Verbindungszeichenfolgen stehen auskommentiert in der `.env` als Rückweg.

---

## Architektur-Grundsatz (Source of Truth)

```
Client → Fastify (/api) → 1. PostgreSQL schreiben (ggf. mit Zeilensperre)
                        → 2. publish() auf den Ereignis-Bus (Kanal "lagerhub")
                        → 3. /ws verteilt Event an alle verbundenen Clients
```

- **PostgreSQL gewinnt immer.** Jede zustandsändernde Aktion wird zuerst dort festgeschrieben.
- **Der Ereignis-Bus ist reiner Verteiler** (`src/events.ts`). Er hält keine Daten; fällt eine Zustellung aus, fehlt nur ein Live-Update, nie ein Datensatz.
- ⚠️ **Der Bus läuft prozessintern und trägt deshalb genau EINEN Backend-Prozess.** Bei zwei Instanzen sähe ein Client nur die Ereignisse seines eigenen Prozesses – dann braucht es wieder einen echten Broker (Redis/Memurai) oder Postgres `LISTEN/NOTIFY`. Auszutauschen wäre allein `events.ts`; die ~35 `publish("lagerhub", …)`-Aufrufstellen bleiben unverändert.
- **Schritt-Status wird immer abgeleitet**, nie direkt gespeichert.

---

## Projektstruktur

```
C:\LagerHub
├── .claude\
│   └── settings.local.json
├── backend\
│   ├── .claude\
│   │   └── settings.local.json
│   ├── prisma\
│   │   ├── migrations\   (20260606195704_init, …)
│   │   └── schema.prisma
│   ├── src\
│   │   ├── routes\      (assignments, employees, pool, reminders, settings, skills,
│   │   │                  stats, steps, tasks)
│   │   ├── services\    (scheduler.ts, stepStatus.ts, push.ts, journalRetention.ts,
│   │   │                  reminders.ts, …)
│   │   ├── scripts\     (backfill-worklog.ts, test-push.ts = Dev-Push-Auslöser,
│   │   │                  fix-orphaned-assignments.ts = Altlasten-Aufräumer,
│   │   │                  check-db.ts = Verbindungs-Diagnose für den
│   │   │                  Installationstag, `npm run db:check`)
│   │   ├── auth.ts      (JWT-Guards: authAny/authDashboard/authManager/authAdmin)
│   │   ├── auth.test.ts (Rollen-Guard-Tests via Fastify inject)
│   │   ├── db.ts        (Prisma-Singleton + Query-Logging >5 ms)
│   │   ├── index.ts     (Bootstrap)
│   │   ├── events.ts    (Ereignis-Bus: publish/subscribe, prozessintern)
│   │   └── server.ts    (Fastify-Instanz, JWT, CORS, WS, Routen)
│   ├── .env             (Secrets – nicht im Repo)
│   ├── .env.example
│   ├── .gitignore
│   ├── package.json
│   ├── package-lock.json
│   ├── prisma.config.ts (Prisma-7-Konfiguration: Verbindung für Migrationen,
│   │                     lädt die .env selbst – MUSS mit auf den Server)
│   └── tsconfig.json
├── frontend\               (Manager-Dashboard – React 19 + Vite)
│   ├── src\
│   │   ├── api\          (client.ts = Fetch-Wrapper, queries.ts = TanStack-Query-Hooks,
│   │   │                  useRealtime.ts = WS-Invalidierung, types.ts)
│   │   ├── tabs\         (TasksTab, PoolTab, EmployeesTab, RemindersTab, StatsTab,
│   │   │                  HistoryTab, SettingsTab)
│   │   ├── components\   (AnalyticsSection, EmployeeDetailSection, JournalRunCard,
│   │   │                  NotesPanel, UtilizationGauge, Logo, KebabMenu, LoginScreen,
│   │   │                  StepAge, CompletionNotePrompt, ReminderBanner,
│   │   │                  ReminderJournal,
│   │   │                  useFloatingMenu.ts = Portal-/fixed-Platzierung für Menüs)
│   │   ├── lib\          (statsExport.ts = Excel/SheetJS, chartColors.ts,
│   │   │                  formatDuration.ts = Minuten → "1 h 16 min",
│   │   │                  stepAge.ts = Bezugspunkt/Ampel je Status, useNow.ts = 30-s-Takt,
│   │   │                  reminderFormat.ts = Fälligkeit/Takt/Entscheidung in Worten)
│   │   ├── App.tsx       (Tab-Shell + Live-Status)
│   │   ├── main.tsx      (Bootstrap, QueryClientProvider)
│   │   ├── vite-env.d.ts (Vite-Client-Typen; ohne sie bricht der Build ab TS 7)
│   │   └── styles.css
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts    (Dev-Proxy /api + /ws → Backend :3000)
├── pwa\                    (Mitarbeiter-App – eigene React-19-+-Vite-6-PWA)
│   ├── src\
│   │   ├── api\          (client.ts, queries.ts, useRealtime.ts, session.ts, push.ts, types.ts)
│   │   ├── components\   (LoginScreen, PoolList, NotesPanel, Notices, PushToggle)
│   │   ├── sw.ts         (Service Worker: Web-Push-Empfang; injectManifest, kein tsc)
│   │   ├── App.tsx       (Login-Gate + Topbar + Arbeitsansicht)
│   │   ├── main.tsx
│   │   └── styles.css    (mobile-first)
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts    (Port 5174, Dev-Proxy /api + /ws → :3000, VitePWA)
├── docs\           (Serveruebergabe/Installationstag/IT-Abstimmung/Stick-Liesmich,
│                     alle als HTML; pack-stick.ps1 kopiert nur docs\*.html)
└── CLAUDE.md
```

---

## Umgebungsvariablen (.env)

```
# Lokale PostgreSQL 17. Beide URLs zeigen auf dieselbe Verbindung – der Umweg über
# zwei verschiedene Pooler entfällt, ebenso pgbouncer=true und connection_limit=1.
DATABASE_URL="postgresql://lagerhub:[PASSWORD]@localhost:5432/lagerhub"
DIRECT_URL="postgresql://lagerhub:[PASSWORD]@localhost:5432/lagerhub"
PORT=3000
# Bind-Adresse, Default "localhost" (siehe Abschnitt „Lokales HTTPS")
#HOST=localhost

# JWT-Secret für die API-Auth – PFLICHT (Server startet sonst nicht/Fail-fast).
# Langer Zufallswert (z. B. `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`).
# Beim Ändern werden alle ausgestellten Tokens ungültig (alle müssen sich neu anmelden).
JWT_SECRET=""
JWT_EXPIRES_IN="12h"          # optional, Default 12h (Formate: "12h", "1d", "30m")
CORS_ORIGIN=""                # optional, kommagetrennte erlaubte Origins; leer = jeden spiegeln (Dev)

# Web Push (VAPID) – mit `npx web-push generate-vapid-keys` erzeugen
VAPID_PUBLIC_KEY=""
VAPID_PRIVATE_KEY=""

# Geheime Admin-PINs für die Dashboard-Vollansicht (Rolle ADMIN) – KEIN MA-Datensatz,
# keine Migration. Format "PIN:Name", mehrere mit Komma. Geheim (nur in .env, gitignored;
# die echten PINs NICHT hier dokumentieren).
ADMIN_PINS="1234:Admin,5678:Chef"
```

> **Warum lokal statt Supabase:** Die DB-Strecke lief übers offene Internet nach Frankfurt.
> Das kostete nicht nur Latenz (`/api/pool` warm ~150 ms, kalt bis ~360 ms; jetzt ~11 ms bei
> leerer DB), sondern zwang wegen des Transaction-Poolers zu **`connection_limit=1`** – womit
> gleichzeitige Anfragen sich gegenseitig serialisierten. Beides ist mit der lokalen Instanz weg.
> Dazu kam, dass ein pausiertes Gratis-Projekt den Dev-Betrieb komplett anhielt („tenant not found").

> **Nebengewinn: die erste echte Test-DB des Projekts.** Der seit Monaten offene
> Race-Condition-Test auf `assignments.ts` (`FOR UPDATE`, siehe „Offene Punkte") ist damit
> schreibbar – Zeilensperren lassen sich nicht mocken, dafür brauchte es eine laufende Postgres.

> **Zugang:** Rolle `lagerhub`, Datenbank `lagerhub`, nur auf `localhost`. Das Passwort des
> `postgres`-Superusers (Wartung, pgAdmin, `pg_dump`) steht als auskommentierte Zeile am Ende
> der `.env` – von der Anwendung ungenutzt, aber auffindbar. **Auf dem Firmenserver gilt
> dieselbe Aufteilung**, siehe `backend/.env.production.example`.

> **`sslmode` entfällt lokal.** Bei einer Verbindung über die Loopback-Schnittstelle gibt es
> keine Strecke zum Abhören; die frühere beidseitige TLS-Festlegung (`sslmode=require` plus
> „Enforce SSL" im Supabase-Dashboard) hatte genau den Zweck, dass der Weg übers Internet nicht
> im Klartext läuft. Wandert die DB je auf einen anderen Rechner, muss das zurück – dann aber
> gleich als `verify-full` mit hinterlegter CA (`require` allein prüft kein Zertifikat).

> Hinweis zu Migrationen (**ab Prisma 7 geändert**): Im `schema.prisma` stehen **keine**
> Verbindungszeichenfolgen mehr – `url`/`directUrl` sind dort nicht mehr erlaubt. Die
> Migrations-Verbindung liest **`backend/prisma.config.ts`** (`DIRECT_URL`, sonst
> `DATABASE_URL`); die Laufzeit-Verbindung baut `src/db.ts` als Driver Adapter. Die Config
> lädt die `.env` ausdrücklich selbst – die Prisma-CLI tut das ab Version 7 nicht mehr.
> Lokal sind beide URLs identisch; die frühere Unterscheidung (Transaction- vs.
> Session-Pooler) war allein eine Supabase-Eigenheit.
>
> `npm run migrate:deploy` (= `prisma migrate deploy`) ist der Befehl für den
> Installationstag – **`prisma.config.ts` muss dafür auf dem Server liegen**, sonst findet
> Prisma keine Verbindung. `pack-stick.ps1` prüft das.

---

## Lokales HTTPS (Entwicklung)

Beide Dev-Server laufen über **HTTPS** (`https://localhost:5173` / `:5174`), das Backend
bleibt **unverschlüsseltes HTTP auf `localhost:3000`**. Das ist kein halber Umstieg,
sondern genau das Produktionsbild: dort terminiert **IIS** das TLS und proxyt auf
denselben lokalen Node-Prozess. Der Browser sieht nie etwas anderes als HTTPS.

**Warum überhaupt lokal:** ohne **Secure Context** gibt es keinen Service Worker –
also **kein Web-Push und keine PWA-Installation**. Über `http://<LAN-IP>` fiel das
bisher aus, M4 war am echten Handy nicht testbar (nur auf `localhost`).

| Baustein | Wo |
|---|---|
| Zertifikat erzeugen | `dev-certs.ps1` (Wurzel) → legt `certs/` an |
| Einbindung | `server.https` in beiden `vite.config.ts` (liest `../certs/`) |
| Aufruf | `start.ps1` erzeugt das Zertifikat automatisch, falls es fehlt |

**Eigene Mini-CA statt eines einzelnen selbstsignierten Zertifikats.** Nur so
installiert ein Handy **einmal** die CA und vertraut danach jedem neu erzeugten
Zertifikat – z. B. nach einem IP-Wechsel per DHCP. Ein Einzelzertifikat müsste bei
jeder Neuausstellung erneut auf jedes Gerät. Deshalb erzeugt `dev-certs.ps1` die CA
**nur einmal** und verwendet sie danach wieder (`-Force` erzwingt neu, kostet aber
das Vertrauen aller Geräte).

- **SANs** werden beim Ausstellen automatisch gesammelt: `localhost`, der Rechnername,
  `127.0.0.1`, `::1` und alle echten IPv4-Adressen des Rechners (APIPA `169.254.*`
  ausgenommen). Die LAN-IP steckt also mit drin – das ist die Adresse, unter der das
  Handy die PWA aufruft.
- **Eintrag in den Windows-Speicher über `certutil -user -addstore Root`**, nicht über
  `Import-Certificate`: letzteres verlangt für den Root-Speicher einen Bestätigungsdialog
  und scheitert in einer Sitzung ohne Oberfläche mit „Die Benutzeroberfläche ist für
  diesen Vorgang nicht zulässig".
- **openssl-Aufrufe laufen über `Start-Process`.** In PowerShell 5.1 macht ein
  umgeleitetes stderr eines nativen Programms einen `NativeCommandError` – openssl
  schreibt seine Fortschrittspunkte genau dorthin. Zusätzlich zerlegt PS 5.1 ein
  Argument-Array an Leerzeichen, der Zertifikatsname muss also selbst gequotet werden.
- **`certs/` ist gitignored** (enthält private Schlüssel). Das Zertifikat gehört zur
  Maschine, nicht ins Repo.

**Fürs Handy** muss `certs/lagerhub-dev-ca.crt` einmal auf das Gerät und dort als
CA installiert werden (Android: Einstellungen → Sicherheit → Zertifikat installieren →
**CA-Zertifikat**). Ohne das verweigert Chrome den Service Worker und Push bleibt aus.

**Das Backend bindet nur noch `localhost`** (`HOST` in `index.ts`, überschreibbar per
`.env`). Vorher lag die Klartext-API auf `0.0.0.0:3000` und damit für jeden im Netz
offen – inklusive Bearer-Token; das HTTPS der beiden Apps wäre schlicht umgehbar
gewesen. Gebunden wird `"localhost"` statt `"127.0.0.1"`, damit Fastify IPv4 **und**
IPv6 belegt: der Vite-Proxy verbindet sich je nach Auflösungsreihenfolge auf `::1`.

**Grenze (bewusst):** Das ist eine Dev-CA für diese eine Maschine. In Produktion kommt
das echte Zertifikat auf den internen Namen (win-acme/DNS-01, siehe Übergabe-Doku) –
dort ist keine Handarbeit pro Gerät nötig, und genau deshalb wurde dieser Weg gewählt.

---

## Auslieferung in Produktion (IIS)

Auf dem Firmenserver liefert **IIS** die gebauten Frontends aus und terminiert TLS;
das Backend bleibt derselbe Node-Prozess auf `localhost:3000`. Zwei Websites, je ein
interner Name, jede mit dem eigenen `dist/` als Wurzel.

**Die `web.config` liegt in `public/`, nicht in `dist/`.** `vite build` kopiert
`public/` unveraendert mit – das Build-Ergebnis ist damit direkt das
Website-Verzeichnis, es gibt keinen Schritt, den man beim Deployen vergessen kann.
Laege sie in `dist/`, wuerde sie bei jedem Build geloescht.

| Regel/Einstellung | Warum sie drin steht |
|---|---|
| Rewrite `^(api\|ws)(/.*)?$` → `localhost:3000` | Weiterleitung an den Dienst. **Muss vor der SPA-Regel stehen**, sonst verschluckt diese `/api` |
| SPA-Fallback auf `index.html` | ohne das gibt ein Neuladen auf einer Unterseite 404 |
| `<webSocket enabled="true" />` | ohne das Windows-Feature bleibt `/ws` **ohne Fehlermeldung** stumm – die komplette Live-Aktualisierung |
| MIME `.webmanifest` / `.json` / `.svg` | IIS kennt sie nicht und antwortet mit 404 |
| `.html` = `DisableCache` | `index.html` verweist auf gehashte Dateinamen; aus dem Cache laedt der Browser nach einem Update die alte Fassung |
| PWA: `sw.js`/`registerSW.js`/`manifest.webmanifest` = `DisableCache` | der Service Worker entscheidet, welche Fassung auf dem Handy laeuft, **und traegt die Push-Behandlung** |
| HSTS `max-age=31536000` | es gibt keinen http-Betrieb. Kehrseite: laeuft das Zertifikat ab, laesst sich die Warnung nicht mehr wegklicken – die win-acme-Erneuerung muss laufen |

**Serverseitig, nicht in der `web.config` abbildbar** (gehoert in die Einrichtung):
ARR-Proxy einschalten (sonst antwortet `/api` mit 404), Windows-Feature
„WebSocket Protocol", und die Zeitzone.

> ⚠️ **`X-Forwarded-For` am Einrichtungstag pruefen.** Fastify laeuft mit
> `trustProxy: true`, `req.ip` kommt also aus diesem Header. ARR setzt ihn selbst –
> **falls nicht**, sieht der Server jede Anfrage als `127.0.0.1`, und der
> Login-Rate-Limiter (10 Versuche/Minute **pro IP**) wird zu einem gemeinsamen
> Zaehler fuer das ganze Haus: nach zehn Anmeldungen bekommt jeder 429. Fehlt der
> Header, in der Rewrite-Regel ergaenzen und die Variable freischalten:
> `appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_FOR']" /commit:apphost`
> (ohne die Freischaltung antwortet IIS mit **500.50**).

### WebSocket haelt sich jetzt selbst wach

Der Kanal ist die meiste Zeit still – Ereignisse kommen nur, wenn wirklich etwas
passiert. Ein Reverse-Proxy kappt eine untaetige Verbindung nach seinem
Leerlauf-Zeitlimit (IIS/ARR: **30 s** Standard). Zwei Aenderungen dagegen:

- **`server.ts` sendet alle 20 s einen Ping** (`HEARTBEAT_MS`) und raeumt Verbindungen
  ab, die nicht antworten – das haelt die Verbindung offen **und** verhindert, dass
  halboffene Sockets dauerhaft in `clients` liegen bleiben.
- **Beide `useRealtime.ts` laden nach einem Wiederverbinden nach.** Der Bus wiederholt
  nichts: was waehrend eines Abrisses gefallen ist, ist weg. Vorher setzte `onopen`
  nur den Status – die Oberflaeche zeigte bis zum naechsten Ereignis stillschweigend
  veraltete Daten. Beim **ersten** Verbinden passiert das bewusst nicht (die Queries
  laufen ohnehin gerade), dafuer der `reconnectedRef`-Merker.

### Produktions-`.env`

`backend/.env.production.example` ist die Vorlage (auf dem Server nach `.env`
kopieren). Gegenueber der Entwicklung: **`NODE_ENV=production`**, **`TZ=Europe/Berlin`**
(Absicherung, falls die Server-Zeitzone falsch steht – Scheduler und Tagesgrenzen
rechnen mit der lokalen Zeit des Prozesses), **`HOST=localhost`**, DB ohne die
Supabase-Pooler-Parameter (`pgbouncer`/`connection_limit=1` entfallen), **neues
`JWT_SECRET`**, **neue `ADMIN_PINS`**, `CORS_ORIGIN` = die beiden Website-Adressen.

### Übergabe-Paket (`pack-stick.ps1`)

Schnürt das, was auf einen Stick kommt: `LagerHub-Uebergabe-<Datum>\` plus ZIP
(SHA256 daneben). Aufbau folgt genau der Übergabe-Doku – `LagerHub\` wandert
**unverändert** auf den Server, `backend\dist` als Dienst, `frontend\dist` und
`pwa\dist` als IIS-Wurzeln.

| Entscheidung | Warum |
|---|---|
| **`backend\node_modules` liegt bei** (~550 MB, gezippt ~215 MB) | Der Server braucht beim Einrichten dann kein `registry.npmjs.org`: `npm ci` **und** `npm run build` entfallen, und `prisma migrate deploy` läuft offline, weil die Prisma-Kommandozeile mit im Baum liegt (sie ist eine `devDependency` – ein `npm ci --omit=dev` hätte sie weggelassen und `migrate deploy` wäre auf dem abgeschotteten Server gescheitert) |
| `frontend`/`pwa` nur als `dist` + Quellcode, **ohne** `node_modules` | Ein Neubau dort ist Sache des Entwicklers, nicht der IT – das spart ~400 MB |
| Ausgeschlossen: **`.env*`** (Whitelist für die zwei `.example`), `certs\`, `.git\`, `.claude\` | Die Git-Historie enthält die alten, als kompromittiert geltenden Admin-PINs. Beim ersten Testlauf rutschte eine vergessene **`.env.bak`** durch – deshalb ist die Regel jetzt „alles Env-Artige raus, Vorlagen gezielt zurück" statt einer Aufzählung bekannter Namen. Dieselbe Verschärfung steht in `backend/.gitignore` |
| **Gegenprüfung nach dem Kopieren** (wirft und verwirft das Paket) | Die Prüfung wiederholt die Ausschlüsse absichtlich: sie soll auch dann greifen, wenn später jemand an der Kopierliste dreht |
| Installationsprogramme (Node, PostgreSQL, ARR, NSSM, win-acme) liegen **nicht** bei | Die gehören aus den geprüften Quellen der IT, nicht von einem fremden Stick. `docs/Stick-Liesmich.html` listet stattdessen Version und Bezugsquelle |
| **`backend\.env` liegt ausgefüllt bei** – `ADMIN_PINS`, **VAPID-Schlüssel** und **Crewmeister-Zugang** im Klartext, `JWT_SECRET` beim Packen frisch erzeugt (`-OhneAdminPins` schaltet die ganze Vorbelegung ab) | Ausdrückliche Entscheidung des Betreibers, am 23.09.2026 auf VAPID + Crewmeister erweitert: am Installationstag soll möglichst nichts einzutragen sein. Nach der Installation ist die DB leer, es gibt **keinen** Mitarbeiter-Datensatz – die Admin-PIN ist die einzige Tür ins System. Preis: **der Stick öffnet damit auch die Zeiterfassung**, ein Fremdsystem mit den Arbeitszeiten aller MA – qualitativ mehr als die eigenen Admin-PINs. Die Werte zieht das Skript aus der lokalen `backend/.env` – **nie** aus dem Skript selbst, sonst stünden Geheimnisse wieder im versionierten Code (genau der Fehler, der die alten PINs kompromittiert hat). **`JWT_SECRET` wird bewusst NICHT übernommen**, sondern gewürfelt: das Dev-Secret hat auf dem Server nichts zu suchen, und ein leeres Feld liesse den Dienst per Fail-fast nicht starten – die IT müsste also doch etwas eintragen. **Platzhalter bleiben nur `DATABASE_URL`/`DIRECT_URL`** (das Kennwort vergibt die IT beim `CREATE USER`) **und `CORS_ORIGIN`** (Hostnamen stehen noch nicht fest; leer = jeder Origin + Startwarnung). Geschrieben wird **ohne BOM** (ein BOM in einer `.env` war schon einmal teuer, siehe PostgreSQL-Umstellung) und **zeilenweise statt per `[regex]::Replace`** – im .NET-Ersatztext ist `# LAGERHUB – Claude Code Projektanleitung

## Projektübersicht
**Warehouse Task Management System** – Echtzeit-Aufgabenverwaltung für Lagerteams.

- **Manager-Dashboard:** React + WebSockets (Echtzeit-Übersicht, Aufgaben, Statistik)
- **Mitarbeiter-App:** Progressive Web App (PWA) – mobiloptimiert, kein Offline-Modus

---

## Tech-Stack (IST-Zustand – so ist der Code gebaut)

| Schicht | Technologie |
|---|---|
| Backend | **Node.js 24 + Fastify 5** + @fastify/websocket 11 |
| Sprache | TypeScript 7 (native Neuimplementierung; lief ohne Codeanpassung durch) |
| Datenbank | **PostgreSQL 17, lokal** (Windows-Dienst `postgresql-x64-17`) – früher Supabase-Cloud |
| ORM | **Prisma 7** – Verbindung als **Driver Adapter** (`@prisma/adapter-pg`) in `src/db.ts`, Migrations-Verbindung in `prisma.config.ts`. `url`/`directUrl` sind im Schema NICHT mehr erlaubt |
| Echtzeit-Verteilung | **Prozessinterner Ereignis-Bus** (`events.ts`, Node-`EventEmitter`), Kanal `lagerhub` – früher Redis Pub/Sub |
| Validierung | zod 4 |
| Scheduler | node-cron 4 (bringt eigene Typen mit – `@types/node-cron` ist entfernt) |
| Auth | **JWT via `@fastify/jwt` (v10, Fastify-5-kompatibel)** – zustandsloses Bearer-Token, `preHandler`-Rollen-Guards (`auth.ts`); kein DB-Session-Store |
| Push | **Web Push via VAPID** (`web-push`) – ersetzt firebase-admin (Backend fertig) |
| Frontend (Manager-Dashboard) | **React 19 + Vite 8** (Vite 8 bundelt mit **Rolldown** statt Rollup), TanStack Query, nativer WebSocket (`/ws`), **Recharts** (Diagramme in der Auswertung), **SheetJS (`xlsx`)** (Excel-Export der Statistiken) |
| Mobile (Mitarbeiter-App) | **PWA – eigene React-19-+-Vite-8-App (`pwa/`)**, `vite-plugin-pwa` 1.x (**injectManifest**, eigener `src/sw.ts`), TanStack Query, nativer WebSocket. Arbeitsansicht (M2), Angebote/Notizen (M3), **Web-Push-Empfang (M4, Service Worker + `PushManager.subscribe`)**. Push braucht HTTPS/localhost (Secure Context) – lokal ist das seit der Dev-HTTPS-Umstellung auch über die LAN-IP gegeben. |

> ⚠️ **NICHT migrieren auf Express/Socket.io.** Der gesamte Server, die Client-Registry
> und die Client-Registry sind auf Fastify gebaut und funktionieren.
> ⚠️ **Redis ist bewusst entfernt** (Umzug auf Windows Server, siehe unten). Nicht
> wieder einführen, ohne dass es zwei Backend-Prozesse gibt – dann aber zwingend.
> ⚠️ KEIN FastAPI, KEIN Python, KEIN SQLite.
> ⚠️ KEIN Firebase. `firebase-admin` ist entfernt, `web-push` ist installiert; die Push-
> *Logik* ist im **Backend** (`services/push.ts`) **und** die PWA-Empfangsseite (Service Worker
> `pwa/src/sw.ts` + Abo, M4) sind **fertig** und end-to-end verifiziert. Push funktioniert nur im
> **Secure Context** (HTTPS/localhost). Der Dev-Betrieb läuft deshalb über HTTPS – siehe
> Abschnitt „Lokales HTTPS (Entwicklung)".
> ⚠️ Frontend: **kein Redux/Zustand/MobX, kein Axios** – State läuft über TanStack Query, Fetch über den schlanken Wrapper in `api/client.ts`. WebSocket dient nur als Invalidierungs-Signal, nicht als Daten-/State-Kanal.
> ℹ️ **Supabase ist raus** (seit 07.09.2026). Die Datenbank läuft lokal; die alten
> Verbindungszeichenfolgen stehen auskommentiert in der `.env` als Rückweg.

---

## Architektur-Grundsatz (Source of Truth)

```
Client → Fastify (/api) → 1. PostgreSQL schreiben (ggf. mit Zeilensperre)
                        → 2. publish() auf den Ereignis-Bus (Kanal "lagerhub")
                        → 3. /ws verteilt Event an alle verbundenen Clients
```

- **PostgreSQL gewinnt immer.** Jede zustandsändernde Aktion wird zuerst dort festgeschrieben.
- **Der Ereignis-Bus ist reiner Verteiler** (`src/events.ts`). Er hält keine Daten; fällt eine Zustellung aus, fehlt nur ein Live-Update, nie ein Datensatz.
- ⚠️ **Der Bus läuft prozessintern und trägt deshalb genau EINEN Backend-Prozess.** Bei zwei Instanzen sähe ein Client nur die Ereignisse seines eigenen Prozesses – dann braucht es wieder einen echten Broker (Redis/Memurai) oder Postgres `LISTEN/NOTIFY`. Auszutauschen wäre allein `events.ts`; die ~35 `publish("lagerhub", …)`-Aufrufstellen bleiben unverändert.
- **Schritt-Status wird immer abgeleitet**, nie direkt gespeichert.

---

## Projektstruktur

```
C:\LagerHub
├── .claude\
│   └── settings.local.json
├── backend\
│   ├── .claude\
│   │   └── settings.local.json
│   ├── prisma\
│   │   ├── migrations\   (20260606195704_init, …)
│   │   └── schema.prisma
│   ├── src\
│   │   ├── routes\      (assignments, employees, pool, reminders, settings, skills,
│   │   │                  stats, steps, tasks)
│   │   ├── services\    (scheduler.ts, stepStatus.ts, push.ts, journalRetention.ts,
│   │   │                  reminders.ts, …)
│   │   ├── scripts\     (backfill-worklog.ts, test-push.ts = Dev-Push-Auslöser,
│   │   │                  fix-orphaned-assignments.ts = Altlasten-Aufräumer,
│   │   │                  check-db.ts = Verbindungs-Diagnose für den
│   │   │                  Installationstag, `npm run db:check`)
│   │   ├── auth.ts      (JWT-Guards: authAny/authDashboard/authManager/authAdmin)
│   │   ├── auth.test.ts (Rollen-Guard-Tests via Fastify inject)
│   │   ├── db.ts        (Prisma-Singleton + Query-Logging >5 ms)
│   │   ├── index.ts     (Bootstrap)
│   │   ├── events.ts    (Ereignis-Bus: publish/subscribe, prozessintern)
│   │   └── server.ts    (Fastify-Instanz, JWT, CORS, WS, Routen)
│   ├── .env             (Secrets – nicht im Repo)
│   ├── .env.example
│   ├── .gitignore
│   ├── package.json
│   ├── package-lock.json
│   ├── prisma.config.ts (Prisma-7-Konfiguration: Verbindung für Migrationen,
│   │                     lädt die .env selbst – MUSS mit auf den Server)
│   └── tsconfig.json
├── frontend\               (Manager-Dashboard – React 19 + Vite)
│   ├── src\
│   │   ├── api\          (client.ts = Fetch-Wrapper, queries.ts = TanStack-Query-Hooks,
│   │   │                  useRealtime.ts = WS-Invalidierung, types.ts)
│   │   ├── tabs\         (TasksTab, PoolTab, EmployeesTab, RemindersTab, StatsTab,
│   │   │                  HistoryTab, SettingsTab)
│   │   ├── components\   (AnalyticsSection, EmployeeDetailSection, JournalRunCard,
│   │   │                  NotesPanel, UtilizationGauge, Logo, KebabMenu, LoginScreen,
│   │   │                  StepAge, CompletionNotePrompt, ReminderBanner,
│   │   │                  ReminderJournal,
│   │   │                  useFloatingMenu.ts = Portal-/fixed-Platzierung für Menüs)
│   │   ├── lib\          (statsExport.ts = Excel/SheetJS, chartColors.ts,
│   │   │                  formatDuration.ts = Minuten → "1 h 16 min",
│   │   │                  stepAge.ts = Bezugspunkt/Ampel je Status, useNow.ts = 30-s-Takt,
│   │   │                  reminderFormat.ts = Fälligkeit/Takt/Entscheidung in Worten)
│   │   ├── App.tsx       (Tab-Shell + Live-Status)
│   │   ├── main.tsx      (Bootstrap, QueryClientProvider)
│   │   ├── vite-env.d.ts (Vite-Client-Typen; ohne sie bricht der Build ab TS 7)
│   │   └── styles.css
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts    (Dev-Proxy /api + /ws → Backend :3000)
├── pwa\                    (Mitarbeiter-App – eigene React-19-+-Vite-6-PWA)
│   ├── src\
│   │   ├── api\          (client.ts, queries.ts, useRealtime.ts, session.ts, push.ts, types.ts)
│   │   ├── components\   (LoginScreen, PoolList, NotesPanel, Notices, PushToggle)
│   │   ├── sw.ts         (Service Worker: Web-Push-Empfang; injectManifest, kein tsc)
│   │   ├── App.tsx       (Login-Gate + Topbar + Arbeitsansicht)
│   │   ├── main.tsx
│   │   └── styles.css    (mobile-first)
│   ├── index.html
│   ├── package.json
│   └── vite.config.ts    (Port 5174, Dev-Proxy /api + /ws → :3000, VitePWA)
├── docs\           (Serveruebergabe/Installationstag/IT-Abstimmung/Stick-Liesmich,
│                     alle als HTML; pack-stick.ps1 kopiert nur docs\*.html)
└── CLAUDE.md
```

---

## Umgebungsvariablen (.env)

```
# Lokale PostgreSQL 17. Beide URLs zeigen auf dieselbe Verbindung – der Umweg über
# zwei verschiedene Pooler entfällt, ebenso pgbouncer=true und connection_limit=1.
DATABASE_URL="postgresql://lagerhub:[PASSWORD]@localhost:5432/lagerhub"
DIRECT_URL="postgresql://lagerhub:[PASSWORD]@localhost:5432/lagerhub"
PORT=3000
# Bind-Adresse, Default "localhost" (siehe Abschnitt „Lokales HTTPS")
#HOST=localhost

# JWT-Secret für die API-Auth – PFLICHT (Server startet sonst nicht/Fail-fast).
# Langer Zufallswert (z. B. `node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"`).
# Beim Ändern werden alle ausgestellten Tokens ungültig (alle müssen sich neu anmelden).
JWT_SECRET=""
JWT_EXPIRES_IN="12h"          # optional, Default 12h (Formate: "12h", "1d", "30m")
CORS_ORIGIN=""                # optional, kommagetrennte erlaubte Origins; leer = jeden spiegeln (Dev)

# Web Push (VAPID) – mit `npx web-push generate-vapid-keys` erzeugen
VAPID_PUBLIC_KEY=""
VAPID_PRIVATE_KEY=""

# Geheime Admin-PINs für die Dashboard-Vollansicht (Rolle ADMIN) – KEIN MA-Datensatz,
# keine Migration. Format "PIN:Name", mehrere mit Komma. Geheim (nur in .env, gitignored;
# die echten PINs NICHT hier dokumentieren).
ADMIN_PINS="1234:Admin,5678:Chef"
```

> **Warum lokal statt Supabase:** Die DB-Strecke lief übers offene Internet nach Frankfurt.
> Das kostete nicht nur Latenz (`/api/pool` warm ~150 ms, kalt bis ~360 ms; jetzt ~11 ms bei
> leerer DB), sondern zwang wegen des Transaction-Poolers zu **`connection_limit=1`** – womit
> gleichzeitige Anfragen sich gegenseitig serialisierten. Beides ist mit der lokalen Instanz weg.
> Dazu kam, dass ein pausiertes Gratis-Projekt den Dev-Betrieb komplett anhielt („tenant not found").

> **Nebengewinn: die erste echte Test-DB des Projekts.** Der seit Monaten offene
> Race-Condition-Test auf `assignments.ts` (`FOR UPDATE`, siehe „Offene Punkte") ist damit
> schreibbar – Zeilensperren lassen sich nicht mocken, dafür brauchte es eine laufende Postgres.

> **Zugang:** Rolle `lagerhub`, Datenbank `lagerhub`, nur auf `localhost`. Das Passwort des
> `postgres`-Superusers (Wartung, pgAdmin, `pg_dump`) steht als auskommentierte Zeile am Ende
> der `.env` – von der Anwendung ungenutzt, aber auffindbar. **Auf dem Firmenserver gilt
> dieselbe Aufteilung**, siehe `backend/.env.production.example`.

> **`sslmode` entfällt lokal.** Bei einer Verbindung über die Loopback-Schnittstelle gibt es
> keine Strecke zum Abhören; die frühere beidseitige TLS-Festlegung (`sslmode=require` plus
> „Enforce SSL" im Supabase-Dashboard) hatte genau den Zweck, dass der Weg übers Internet nicht
> im Klartext läuft. Wandert die DB je auf einen anderen Rechner, muss das zurück – dann aber
> gleich als `verify-full` mit hinterlegter CA (`require` allein prüft kein Zertifikat).

> Hinweis zu Migrationen (**ab Prisma 7 geändert**): Im `schema.prisma` stehen **keine**
> Verbindungszeichenfolgen mehr – `url`/`directUrl` sind dort nicht mehr erlaubt. Die
> Migrations-Verbindung liest **`backend/prisma.config.ts`** (`DIRECT_URL`, sonst
> `DATABASE_URL`); die Laufzeit-Verbindung baut `src/db.ts` als Driver Adapter. Die Config
> lädt die `.env` ausdrücklich selbst – die Prisma-CLI tut das ab Version 7 nicht mehr.
> Lokal sind beide URLs identisch; die frühere Unterscheidung (Transaction- vs.
> Session-Pooler) war allein eine Supabase-Eigenheit.
>
> `npm run migrate:deploy` (= `prisma migrate deploy`) ist der Befehl für den
> Installationstag – **`prisma.config.ts` muss dafür auf dem Server liegen**, sonst findet
> Prisma keine Verbindung. `pack-stick.ps1` prüft das.

---

## Lokales HTTPS (Entwicklung)

Beide Dev-Server laufen über **HTTPS** (`https://localhost:5173` / `:5174`), das Backend
bleibt **unverschlüsseltes HTTP auf `localhost:3000`**. Das ist kein halber Umstieg,
sondern genau das Produktionsbild: dort terminiert **IIS** das TLS und proxyt auf
denselben lokalen Node-Prozess. Der Browser sieht nie etwas anderes als HTTPS.

**Warum überhaupt lokal:** ohne **Secure Context** gibt es keinen Service Worker –
also **kein Web-Push und keine PWA-Installation**. Über `http://<LAN-IP>` fiel das
bisher aus, M4 war am echten Handy nicht testbar (nur auf `localhost`).

| Baustein | Wo |
|---|---|
| Zertifikat erzeugen | `dev-certs.ps1` (Wurzel) → legt `certs/` an |
| Einbindung | `server.https` in beiden `vite.config.ts` (liest `../certs/`) |
| Aufruf | `start.ps1` erzeugt das Zertifikat automatisch, falls es fehlt |

**Eigene Mini-CA statt eines einzelnen selbstsignierten Zertifikats.** Nur so
installiert ein Handy **einmal** die CA und vertraut danach jedem neu erzeugten
Zertifikat – z. B. nach einem IP-Wechsel per DHCP. Ein Einzelzertifikat müsste bei
jeder Neuausstellung erneut auf jedes Gerät. Deshalb erzeugt `dev-certs.ps1` die CA
**nur einmal** und verwendet sie danach wieder (`-Force` erzwingt neu, kostet aber
das Vertrauen aller Geräte).

- **SANs** werden beim Ausstellen automatisch gesammelt: `localhost`, der Rechnername,
  `127.0.0.1`, `::1` und alle echten IPv4-Adressen des Rechners (APIPA `169.254.*`
  ausgenommen). Die LAN-IP steckt also mit drin – das ist die Adresse, unter der das
  Handy die PWA aufruft.
- **Eintrag in den Windows-Speicher über `certutil -user -addstore Root`**, nicht über
  `Import-Certificate`: letzteres verlangt für den Root-Speicher einen Bestätigungsdialog
  und scheitert in einer Sitzung ohne Oberfläche mit „Die Benutzeroberfläche ist für
  diesen Vorgang nicht zulässig".
- **openssl-Aufrufe laufen über `Start-Process`.** In PowerShell 5.1 macht ein
  umgeleitetes stderr eines nativen Programms einen `NativeCommandError` – openssl
  schreibt seine Fortschrittspunkte genau dorthin. Zusätzlich zerlegt PS 5.1 ein
  Argument-Array an Leerzeichen, der Zertifikatsname muss also selbst gequotet werden.
- **`certs/` ist gitignored** (enthält private Schlüssel). Das Zertifikat gehört zur
  Maschine, nicht ins Repo.

**Fürs Handy** muss `certs/lagerhub-dev-ca.crt` einmal auf das Gerät und dort als
CA installiert werden (Android: Einstellungen → Sicherheit → Zertifikat installieren →
**CA-Zertifikat**). Ohne das verweigert Chrome den Service Worker und Push bleibt aus.

**Das Backend bindet nur noch `localhost`** (`HOST` in `index.ts`, überschreibbar per
`.env`). Vorher lag die Klartext-API auf `0.0.0.0:3000` und damit für jeden im Netz
offen – inklusive Bearer-Token; das HTTPS der beiden Apps wäre schlicht umgehbar
gewesen. Gebunden wird `"localhost"` statt `"127.0.0.1"`, damit Fastify IPv4 **und**
IPv6 belegt: der Vite-Proxy verbindet sich je nach Auflösungsreihenfolge auf `::1`.

**Grenze (bewusst):** Das ist eine Dev-CA für diese eine Maschine. In Produktion kommt
das echte Zertifikat auf den internen Namen (win-acme/DNS-01, siehe Übergabe-Doku) –
dort ist keine Handarbeit pro Gerät nötig, und genau deshalb wurde dieser Weg gewählt.

---

## Auslieferung in Produktion (IIS)

Auf dem Firmenserver liefert **IIS** die gebauten Frontends aus und terminiert TLS;
das Backend bleibt derselbe Node-Prozess auf `localhost:3000`. Zwei Websites, je ein
interner Name, jede mit dem eigenen `dist/` als Wurzel.

**Die `web.config` liegt in `public/`, nicht in `dist/`.** `vite build` kopiert
`public/` unveraendert mit – das Build-Ergebnis ist damit direkt das
Website-Verzeichnis, es gibt keinen Schritt, den man beim Deployen vergessen kann.
Laege sie in `dist/`, wuerde sie bei jedem Build geloescht.

| Regel/Einstellung | Warum sie drin steht |
|---|---|
| Rewrite `^(api\|ws)(/.*)?$` → `localhost:3000` | Weiterleitung an den Dienst. **Muss vor der SPA-Regel stehen**, sonst verschluckt diese `/api` |
| SPA-Fallback auf `index.html` | ohne das gibt ein Neuladen auf einer Unterseite 404 |
| `<webSocket enabled="true" />` | ohne das Windows-Feature bleibt `/ws` **ohne Fehlermeldung** stumm – die komplette Live-Aktualisierung |
| MIME `.webmanifest` / `.json` / `.svg` | IIS kennt sie nicht und antwortet mit 404 |
| `.html` = `DisableCache` | `index.html` verweist auf gehashte Dateinamen; aus dem Cache laedt der Browser nach einem Update die alte Fassung |
| PWA: `sw.js`/`registerSW.js`/`manifest.webmanifest` = `DisableCache` | der Service Worker entscheidet, welche Fassung auf dem Handy laeuft, **und traegt die Push-Behandlung** |
| HSTS `max-age=31536000` | es gibt keinen http-Betrieb. Kehrseite: laeuft das Zertifikat ab, laesst sich die Warnung nicht mehr wegklicken – die win-acme-Erneuerung muss laufen |

**Serverseitig, nicht in der `web.config` abbildbar** (gehoert in die Einrichtung):
ARR-Proxy einschalten (sonst antwortet `/api` mit 404), Windows-Feature
„WebSocket Protocol", und die Zeitzone.

> ⚠️ **`X-Forwarded-For` am Einrichtungstag pruefen.** Fastify laeuft mit
> `trustProxy: true`, `req.ip` kommt also aus diesem Header. ARR setzt ihn selbst –
> **falls nicht**, sieht der Server jede Anfrage als `127.0.0.1`, und der
> Login-Rate-Limiter (10 Versuche/Minute **pro IP**) wird zu einem gemeinsamen
> Zaehler fuer das ganze Haus: nach zehn Anmeldungen bekommt jeder 429. Fehlt der
> Header, in der Rewrite-Regel ergaenzen und die Variable freischalten:
> `appcmd set config -section:system.webServer/rewrite/allowedServerVariables /+"[name='HTTP_X_FORWARDED_FOR']" /commit:apphost`
> (ohne die Freischaltung antwortet IIS mit **500.50**).

### WebSocket haelt sich jetzt selbst wach

Der Kanal ist die meiste Zeit still – Ereignisse kommen nur, wenn wirklich etwas
passiert. Ein Reverse-Proxy kappt eine untaetige Verbindung nach seinem
Leerlauf-Zeitlimit (IIS/ARR: **30 s** Standard). Zwei Aenderungen dagegen:

- **`server.ts` sendet alle 20 s einen Ping** (`HEARTBEAT_MS`) und raeumt Verbindungen
  ab, die nicht antworten – das haelt die Verbindung offen **und** verhindert, dass
  halboffene Sockets dauerhaft in `clients` liegen bleiben.
- **Beide `useRealtime.ts` laden nach einem Wiederverbinden nach.** Der Bus wiederholt
  nichts: was waehrend eines Abrisses gefallen ist, ist weg. Vorher setzte `onopen`
  nur den Status – die Oberflaeche zeigte bis zum naechsten Ereignis stillschweigend
  veraltete Daten. Beim **ersten** Verbinden passiert das bewusst nicht (die Queries
  laufen ohnehin gerade), dafuer der `reconnectedRef`-Merker.

### Produktions-`.env`

`backend/.env.production.example` ist die Vorlage (auf dem Server nach `.env`
kopieren). Gegenueber der Entwicklung: **`NODE_ENV=production`**, **`TZ=Europe/Berlin`**
(Absicherung, falls die Server-Zeitzone falsch steht – Scheduler und Tagesgrenzen
rechnen mit der lokalen Zeit des Prozesses), **`HOST=localhost`**, DB ohne die
Supabase-Pooler-Parameter (`pgbouncer`/`connection_limit=1` entfallen), **neues
`JWT_SECRET`**, **neue `ADMIN_PINS`**, `CORS_ORIGIN` = die beiden Website-Adressen.

### Übergabe-Paket (`pack-stick.ps1`)

Schnürt das, was auf einen Stick kommt: `LagerHub-Uebergabe-<Datum>\` plus ZIP
(SHA256 daneben). Aufbau folgt genau der Übergabe-Doku – `LagerHub\` wandert
**unverändert** auf den Server, `backend\dist` als Dienst, `frontend\dist` und
`pwa\dist` als IIS-Wurzeln.

| Entscheidung | Warum |
|---|---|
| **`backend\node_modules` liegt bei** (~550 MB, gezippt ~215 MB) | Der Server braucht beim Einrichten dann kein `registry.npmjs.org`: `npm ci` **und** `npm run build` entfallen, und `prisma migrate deploy` läuft offline, weil die Prisma-Kommandozeile mit im Baum liegt (sie ist eine `devDependency` – ein `npm ci --omit=dev` hätte sie weggelassen und `migrate deploy` wäre auf dem abgeschotteten Server gescheitert) |
| `frontend`/`pwa` nur als `dist` + Quellcode, **ohne** `node_modules` | Ein Neubau dort ist Sache des Entwicklers, nicht der IT – das spart ~400 MB |
| Ausgeschlossen: **`.env*`** (Whitelist für die zwei `.example`), `certs\`, `.git\`, `.claude\` | Die Git-Historie enthält die alten, als kompromittiert geltenden Admin-PINs. Beim ersten Testlauf rutschte eine vergessene **`.env.bak`** durch – deshalb ist die Regel jetzt „alles Env-Artige raus, Vorlagen gezielt zurück" statt einer Aufzählung bekannter Namen. Dieselbe Verschärfung steht in `backend/.gitignore` |
| **Gegenprüfung nach dem Kopieren** (wirft und verwirft das Paket) | Die Prüfung wiederholt die Ausschlüsse absichtlich: sie soll auch dann greifen, wenn später jemand an der Kopierliste dreht |
| Installationsprogramme (Node, PostgreSQL, ARR, NSSM, win-acme) liegen **nicht** bei | Die gehören aus den geprüften Quellen der IT, nicht von einem fremden Stick. `docs/Stick-Liesmich.html` listet stattdessen Version und Bezugsquelle |
 ein Sonderzeichen, ein Passwort mit Dollarzeichen wäre still zerschossen worden. Die Gegenprüfung am Skriptende erzwingt: kein Platzhalter bei den Geheimnissen, `[PASSWORT]` **muss** noch in der DB-Adresse stehen, und das Dev-`JWT_SECRET` darf nicht im Paket auftauchen. Ein Hinweisblock am Dateianfang nennt der IT die zwei offenen Werte; `Stick-Liesmich.html` und Etappe 4 der Installationsanleitung warnen davor, die Datei mit der `.example` zu überschreiben |

Einstieg für die IT ist `docs/Stick-Liesmich.html`, das als **`LIESMICH.html`** in
der Paketwurzel landet (die drei anderen Dokumente unter `Doku\`).

### Update-Paket (`pack-stick.ps1 -Update` + `update.ps1`)

Für einen **bereits eingerichteten** Server. `-Update` baut dasselbe Paket wie oben, aber **ohne `.env`** (die des Servers trägt DB-Kennwort und `JWT_SECRET` – das Erstinstallations-Paket würde sie mit Platzhaltern und neuem Secret überschreiben: keine DB-Verbindung, alle abgemeldet), ohne Einrichtungs-Doku, dafür mit `update.bat`/`update.ps1` in der Paketwurzel. Auf dem Server: entpacken, `update.bat` als Administrator.

| Entscheidung | Warum |
|---|---|
| **`pg_dump` vor allem anderen**, Abbruch bei Fehler | vor einer Schema-Änderung Pflicht; scheitert es, ist noch nichts angefasst |
| Dienst wird **selbst gefunden** (NSSM-`AppDirectory` = `<Installation>\backend`), sonst `-Dienst` | der Name wird erst am Installationstag vergeben |
| Backend-Teile werden **verschoben**, nicht kopiert, bevor die neuen kommen | sofort (auch ~550 MB `node_modules`) und zugleich die Sicherung für den Rückweg; ersetzt wird nur, was **im Paket** liegt – `.env`/Protokolle der IT bleiben |
| `frontend`/`pwa` `dist` per `robocopy /MIR` (vorher Kopie) | IIS kann Dateien darin offen halten, ein Verschieben des Ordners scheitert dann |
| **Abweichende `web.config` bleibt**, neue als `web.config.neu` | die IT passt sie ggf. an (`X-Forwarded-For`) – ein Update darf das nicht still zurückdrehen |
| `db:check` + `migrate deploy` direkt über `node` (tsx-/Prisma-CLI aus `node_modules`) | ohne npm-`.cmd`-Umweg, der aus Skripten heraus unter neuerem Node scheitert |
| **Automatischer Rückweg** bei jedem Fehler ab dem Anhalten | alter Stand zurück, Dienst starten, `/health` prüfen; die DB wird **nicht** automatisch zurückgespielt (destruktiv) – das Fenster nennt den `pg_restore`-Befehl |
| Port für `/health` aus der `.env` (`PORT`) | statt fest 3000 |
| Sicherungen/Protokoll nach `C:\LagerHub-Sicherungen` (außerhalb der Installation), die letzten **drei** Programmstände bleiben | |

**Geprüft (03.10.2026)** gegen eine Probe-Installation (Test-DB, eigener Port, Dienst durch Funktionen ersetzt – Funktionen haben in PowerShell Vorrang vor Cmdlets): Gutfall komplett, angepasste `web.config` erhalten, `.env` unverändert; Fehlerfall (neue Version stürzt beim Start ab) → alter Stand automatisch zurück und erreichbar, Exit 1. **Nicht** geprüft: ein echter NSSM-Dienst und IIS.

> **`npm run build` im Backend räumt `dist` jetzt vorher aus** (`prebuild`).
> `tsc` löscht entfernte Dateien nie – `dist/redis.js` lag noch aus der Zeit vor
> dem Redis-Ausbau dort und wäre mit auf den Server gewandert.

---

## Datenmodell (Prisma – IST-Zustand)

- **Skill** – globaler Katalog, Name eindeutig (= Schrittname 1:1)
- **Employee** – `pin` (4-stellig, eindeutig), `deviceId`, `deviceTrusted`, `role` (`MANAGER`/`OFFICE`/`WORKER` – steuert nur die Dashboard-Oberfläche, **nicht** die Einsetzbarkeit; ADMIN ist KEINE MA-Rolle, sondern eine geheime PIN), `present`/`presenceOverride`/`crewmeisterUserId` (Anwesenheits-Sync), `deletedAt` (Soft-Delete-Marke); n:m Skills via `EmployeeSkill`
- **Task** – `name` eindeutig, `priority` (HIGH/MEDIUM/LOW), `status` (OPEN/RUNNING/COMPLETED, abgeleitet), `poolEnabled`, `orderIndex` (Reihenfolge im Aufgaben-Tab per Drag & Drop; neue Aufgaben oben = kleinster Wert − 1; Migration `add_task_order_index` übernimmt die alte Anzeige-Reihenfolge), `repeat` (Wiederholen: bei `true` hält `finalizeTask` die Aufgabe nach Abschluss im Pool und startet sofort einen neuen Lauf, statt sie herauszunehmen; Migration `add_task_repeat`), `deletedAt` (Soft-Delete-Marke; Name wird beim Löschen freigegeben, TaskRun-Historie bleibt)
- **Step** – gehört zu Task; `minWorkers` (≥2 = Team), `maxWorkers`, `orderIndex`, `startedAt` (Timer-Start); **`availableAt`** (seit wann ist der Schritt **abholbar**, d. h. Status OPEN – Basis für „wartet seit X" und die Eskalations-Schwelle; Migration `add_step_available_at`, siehe „Verfügbarkeits-Uhr"); `notes` (JSON, **append-only Notiz-Verlauf** des aktuellen Laufs: `[{ id, authorType: "MA"|"MANAGER", authorName, text, at, kind?, value?, label? }]`; wird bei Abschluss in den TaskRun-Snapshot eingefroren und für den nächsten Lauf geleert); **`noteRequired`/`noteFormat` (`TEXT`|`NUMBER`)/`noteLabel`** = Pflichtnotiz beim Abschluss (Migration `add_step_required_note`, siehe Kernregel); Vorgänger via `StepPredecessor` (Selbstreferenz)
- **Assignment** – ein MA an einem Schritt; `state` (OFFERED/ACTIVE/PAUSED/DONE/REJECTED), `pausedReason` (SWITCH/END_OF_DAY), `dayKey`. `OFFERED` = vom Manager angeboten, belegt **keinen** Platz; `REJECTED` = abgelehntes Angebot (Beleg für Dashboard-Meldung). Status-Ableitung (`stepStatus.ts`) zählt nur ACTIVE/PAUSED/DONE. **Zeiten:** `startedAt`/`finishedAt` (Start/Ende), `pausedAt` = Beginn des **aktuell offenen** Pausen-Intervalls, `pausedMs` = **kumulierte** Dauer aller abgeschlossenen Pausen (Helper `closePause` in `assignments.ts` addiert das offene Intervall bei Resume/Complete drauf), `switchCount` = **wie oft** die Zuweisung mit Grund SWITCH unterbrochen wurde (Auto-Wechsel + manuelles „Unterbrechen"; Feierabend zählt nicht) – für die Auswertung „wie oft gewechselt". **Netto-Arbeitszeit = `finishedAt − startedAt − pausedMs`.**
- **TaskRun** – Snapshot pro Durchlauf (`data` als JSON: `steps[]` mit `name`, `assignments` (inkl. `startedAt`/`finishedAt`/`pausedMs` → Netto-Arbeitszeit je MA je Schritt), **`notes`** = eingefrorener Notiz-Verlauf; offene Pausen werden beim Einfrieren via `closePause` geschlossen). Früher strikt unveränderlich; **Ausnahme:** Admins dürfen in der Historie Notizen **nachtragen** (append-only an `data.steps[].notes` via `POST /stats/journal/:runId/notes`).
- **WorkLog** – **denormalisierte Auswertungs-Zeile** pro (MA, Schritt, Durchlauf), geschrieben in `finalizeTask` zusätzlich zum TaskRun und per Backfill aus bestehenden Snapshots: `runId` (→ TaskRun, `onDelete: Cascade` → Löschen eines Tagesjournals räumt WorkLogs mit weg), `employeeId`, `taskName`/`stepName` (Snapshot-Namen), `startedAt`/`finishedAt`, `activeMs` (Netto), `pausedMs`, `switchCount` (Anzahl SWITCH-Wechsel, eingefroren aus `Assignment.switchCount`; alte Läufe = 0). Indizes `(employeeId, finishedAt)` + `(finishedAt)`; Zeitraumfilter/Tagesgruppierung laufen über `finishedAt` via `localDayKey` (keine TZ-Off-by-one). Backfill: `npm run backfill:worklog` (idempotent; setzt `switchCount` NICHT rückwirkend – nicht rekonstruierbar).
- **PushSubscription** – Web-Push-Abo pro Gerät; `employeeId`, `endpoint` (eindeutig → Upsert/Dedupe), `subscription` (vollständiges Abo-Objekt als JSON)
- **Reminder** – wiederkehrende Erinnerung (Wartung, Prüfung, Bestellung). **Tagesgenau**, nicht uhrzeitgenau: `dueDate` (lokale Mitternacht) – fällig ist alles `<= heute`. `repeatRule` (`NONE`/`DAILY`/`WEEKLY`/`MONTHLY`/`INTERVAL`) + Parameter `intervalDays`/`weekday`/`dayOfMonth`; `skillId` (nötig für die Aktion „Pool“), `taskId` (die daraus erzeugte Aufgabe – wird wiederverwendet, siehe Kernregel), `active`, `deletedAt` (Soft-Delete). Migration `add_reminders`
- **ReminderEvent** – getroffene Entscheidung = der Journal-Eintrag dazu: `decision` (`DONE`/`POSTPONED`/`POOLED`/`OBSOLETE`), `decidedByName` (**Name als Text**, kein FK – ADMIN hat keine MA-Zeile), `decidedById?`, `decidedAt`, `postponedTo?` (nur beim Verschieben), `reminderTitle` (Snapshot, damit der Eintrag auch nach Umbenennen/Löschen lesbar bleibt). Bewusst **keine** TaskRun-Zeile: eine abgehakte Erinnerung ist keine geleistete Arbeit und darf in Statistik/WorkLog nicht mitzählen
- **Settings** – Singleton (`id = "singleton"`): `workStart`, `workEnd`, `escalationMins`, **`breakStart`/`breakEnd`** (Pause, in der die Eskalation schweigt; gleiche Zeiten = keine Pause; Migration `add_break_window`), **`journalRetentionDays`** (Aufbewahrungsdauer der Tagesjournale in Tagen, Default **0 = deaktiviert**; Migration `add_journal_retention`, siehe Kernregel „Aufbewahrung der Tagesjournale")

Enums: `Priority`, `TaskStatus`, `AssignmentState`, `PausedReason`

---

## Implementierte Routen (`/api/*`)

> 🔒 Alle Routen sind per `preHandler`-Guard (`auth.ts`) rollengeschützt – siehe Kernregel „Auth & Autorisierung". Öffentlich sind nur `/employees/pin-login`, `/employees/login`, `/push/vapid-public-key`, `/health`.

| Route | Status | Aufgabe |
|---|---|---|
| `skills.ts` | ✅ | Liste + Upsert (keine Dubletten) |
| `employees.ts` | ✅ | Liste mit Live-Status, Anlegen (Auto-PIN, vergibt keine reservierten Admin-PINs), **Login** (`/login`: PIN+Device-Trust, liefert MA **+ JWT**), **Dashboard-PIN-Login** (`/pin-login`: liefert Rolle+Name **+ JWT**; erkennt **vor** der MA-Suche eine **geheime Admin-PIN** aus `ADMIN_PINS` → `role=ADMIN`, kein Datensatz – Logik in `adminPins.ts`), Geräte-Reset, **Soft-Delete** (`deletedAt`; gesperrt bei aktiver Zuweisung, Historie bleibt) |
| `tasks.ts` | ✅ | CRU + **Soft-Delete** (`deletedAt`; gesperrt bei aktiver Zuweisung, Name wird freigegeben, Historie bleibt), Priorität ändern (Event `TASK_PRIORITY_HIGH` bei „hoch"), **Reihenfolge** (`POST /reorder`: erwartet **alle** nicht gelöschten Aufgaben, sonst 409 → `TASKS_REORDERED`), **`repeat` umschalten** (Wiederholen an/aus), Copy, Restart |
| `steps.ts` | ✅ | Anlegen (Skill-Upsert, Standard-Vorgänger = letzter Schritt), Update, Delete, **Reorder** (`POST /reorder`: setzt `orderIndex` neu, **leert** dabei „Wartet auf"), **Notiz anhängen** (`POST /:id/notes`: append-only an `Step.notes`; Autor aus dem **Token** – WORKER = MA-Eintrag unter eigenem Namen, sonst Manager-Eintrag → `STEP_NOTE_UPDATED`) |
| `assignments.ts` | ✅ | **Pflichtnotiz:** `complete` nimmt `{ note? }` und weist ohne gültigen Wert mit 400 ab (siehe Kernregel). **Kern-Logik:** atomares Einloggen (`FOR UPDATE`; unter derselben Sperre auch die Prüfung „eine Zuweisung je (MA, Schritt)" → 409, siehe Kernregel; **Selbst-Login `POST /` nimmt `employeeId` aus dem Token**, Body nur `stepId`), Auto-Unterbrechung (intern `PAUSED`), Team-Timer, Complete/Pause/Resume, TaskRun-Schreiben. **Manager-Angebot:** `POST /offer` (unverbindlich, Push an MA), `POST /:id/accept` (→ ACTIVE, gemeinsame `activateOnStep`-Logik), `POST /:id/reject` (→ REJECTED + `ASSIGNMENT_REJECTED`). **Anwesenheit:** abwesende (`present=false`) oder gelöschte MA werden in `activateOnStep` (Login/Accept), `POST /offer` **und `POST /:id/resume`** mit 409/404 abgelehnt. **Team-Abschluss:** `complete` eines Team-Schritts nur ab Start (`startedAt != null`, min erreicht), sonst 409. **Übernahme-Abschluss:** bei einem Einzel-Slot-Schritt (`maxWorkers === 1`) schließt `complete` auch die noch `PAUSED` hängende Zuweisung des Vorgängers mit als `DONE` ab (sonst bliebe der Schritt „unterbrochen"); `closePause` rechnet dessen Arbeitszeit sauber heraus. **Erinnerung:** nach `complete` prüft `remindOwnInterruptedSteps`, ob der abschließende MA noch unterbrochene (`PAUSED`) Schritte offen hat → `WORK_REMINDER` je Schritt + Best-Effort-Push (nicht zeitbasiert, sondern genau beim Abschluss). **Verlassen:** `POST /:id/leave` entfernt die eigene Zuweisung **komplett** (Platz frei, KEINE Arbeitszeit gebucht) – nur solange der Schritt **noch nicht gestartet** ist (`startedAt === null`, d. h. Team-Schritt im Status WAITING); nach Timer-Start 409. Atomar via `FOR UPDATE` + `deleteMany`-Guard, danach `afterAssignmentChange`. **Perf:** Anwesenheit+Fähigkeit in einer Abfrage (employee mit gefiltertem `skills`-Include); `afterAssignmentChange` leitet Aufgaben-, Einzel-Schritt-Status und Team-Understaffed aus **einem** `step.findMany` ab. |
| `pool.ts` | ✅ | Freigegebene Pool-Schritte, gefiltert nach Skill/MA (**ein WORKER wird per Token auf die eigene Identität gezwungen**; Dashboard-Rollen sehen frei). Liefert **nicht gesperrte** Schritte inkl. **erledigter** (DONE, nur zur Notiz-Bearbeitung mitgeführt; gesperrte/LOCKED nie); Aufgabe wird nur gelistet, wenn es offene Schritte gibt. **Eine** Abfrage liefert Anzeige- **und** Status-Daten (alle Assignment-States + Vorgänger samt deren Assignments); Status in JS via `deriveStepStatus`, kein N+1, kein zweiter Query. Relationen per `relationLoadStrategy: "join"`. **Aufgaben-Reihenfolge fest per `orderBy: [orderIndex, name]`** – beide Clients sortieren nur nach Priorität und verlassen sich auf den stabilen `Array.sort`; bei gleicher Priorität gilt damit die Reihenfolge aus dem Aufgaben-Tab. Ohne `orderBy` wäre der Gleichstand die ungeordnete Postgres-Rückgabe (Karten tauschen nach einem Zeilen-Update die Plätze). `name` ist eindeutig → totale Ordnung. |
| `stats.ts` | ✅ | Tages-KPIs (`/`: `stepsCompletedToday` = heute erledigte **Arbeitsschritte** = Summe der Schritte aller heutigen TaskRuns; die Zahl der abgeschlossenen **Durchläufe** steht in `/tasks-by-status` als `completed`. Beide aus **TaskRun**, NICHT `Task.status=COMPLETED` – finalizeTask setzt die Aufgabe auf OPEN zurück, der Status-Zähler wäre sonst fast immer 0), Status-Verteilung, **Auslastung** (`/employee-load`: Live-Übersicht je MA – aktuell bearbeitete `currentTask`/`currentStep` (falls gerade ACTIVE), `currentSince` (pausenbereinigter Start der laufenden Zuweisung als ISO) und `activeBaseMs` (heutige Netto-Zeit **ohne** die laufende Zuweisung); das Frontend lässt die Uhr daraus sekündlich mitlaufen. **Quellen: heutige WorkLogs (bereits abgeschlossene Arbeit, deren Live-Zuweisungen bei finalizeTask gelöscht wurden) + bestehende Live-Zuweisungen** – so bleiben MA sichtbar, die heute schon eine Aufgabe fertig haben), **Tagesjournal** (`/journal`: ohne Param heute, mit `?date=YYYY-MM-DD` ein Tag; je Eintrag Dauer, beteiligte MA, **Schritt-Notizen** sowie pro Schritt `workers[]` = beteiligte MA mit Einzelzeiten `activeMinutes` (Netto) / `pausedMinutes`, aus den Snapshot-Zeiten berechnet), **Journal-Tage** (`/journal/days`: `[{date,count}]`), **Historie-Notiz nachtragen** (`POST /journal/:runId/notes`), **Tag löschen** (`DELETE /journal/:date`: Hard-Delete, nur Vergangenheit → `JOURNAL_DELETED`), Historie (`/history`), **Auswertung** (`/employee-history?from=&to=` aus WorkLog: je MA `activeMinutes`/`stepCount`/`taskCount`/`avgStepMinutes`; `/throughput?from=&to=` aus TaskRun: `perDay` Läufe+Ø Dauer inkl. Null-Tage, `avgByTask`; Default beider: letzte 7 Tage), **Ø Zeit je Arbeitsschritt** (`/step-durations?from=&to=` aus WorkLog, **nur ADMIN**: gruppiert nach **(taskName, stepName)** – der Schrittname allein ist nicht eindeutig (= Skillname, kommt in mehreren Aufgaben vor); je Gruppe `avgMinutes`/`count`/`minMinutes`/`maxMinutes`. Kennzahl = **Netto-Aktivzeit** (`activeMs`, Unterbrechungen abgezogen) **pro Person**; bei Team-Schritten also je MA, nicht die Wanduhr-Dauer. Default letzte 7 Tage), **MA-Detail** (`/employee-detail?employeeId=&from=&to=`, **nur ADMIN**: Kopf-KPIs, je Schritttyp, Einzelvorkommen+Notizen, Aufgaben-Verteilung, Pro-Tag inkl. **inaktiver Zeit** – siehe „Inaktive Zeit") |
| `settings.ts` | ✅ | Arbeitszeiten, Eskalations-Schwellwert, **Pause** (`breakStart`/`breakEnd`) + **Aufbewahrungsdauer der Tagesjournale** (`journalRetentionDays`, 0–3650; bei geändertem Wert räumt `PATCH` sofort per `purgeOldJournals()` auf, statt bis zum nächtlichen Lauf zu warten – der Effekt der Eingabe soll direkt sichtbar sein). **Lesen ist `authAny`** (nicht `authDashboard`): die PWA braucht `escalationMins` für die Alters-Ampel der Schritte – ein eigener Schwellwert dort würde etwas anderes „zu lange" nennen als die Eskalation. Inhalt sind Betriebsparameter, keine Geheimnisse; **Schreiben ist `authAdmin`** (vorher `authManager`): die Einstellungen sind im Dashboard ein ADMIN-exklusiver Tab – ohne die Verschärfung wäre das eine reine Oberflächen-Sperre, die per API zu umgehen ist. **Validierung:** `TimeString` prüft echte Uhrzeiten (die alte Regex `\d{2}:\d{2}` ließ `99:99` durch); die Ordnung „Ende nach Beginn" wird gegen den Stand **nach dem Merge** geprüft – ein PATCH darf einzelne Felder schicken, „workEnd allein" muss also gegen das gespeicherte `workStart` geprüft werden, sonst ließe sich die Ordnung in zwei Schritten aushebeln. Bei der Pause ist `start == end` erlaubt (= deaktiviert). |
| `reminders.ts` | ✅ | Erinnerungen: Liste (`GET /`), **fällige** (`GET /due` – fürs Dashboard-Banner), Anlegen/Ändern/Soft-Delete (**authManager**), **Entscheiden** (`POST /:id/decide`, **authDashboard** – auch das Büro darf abhaken, es wird ja namentlich protokolliert). `decide` schreibt das `ReminderEvent` und setzt den nächsten Termin in **einer** Transaktion; bei `POOLED` entsteht (oder erwacht) die zugehörige Aufgabe im Pool |
| `push.ts` | ✅ | VAPID-Public-Key ausliefern (public), Abo speichern (`/subscribe`, Upsert per endpoint, **`employeeId` aus dem Token**), `/unsubscribe` |

## Services

- **`stepStatus.ts`** – leitet Schritt-Status (LOCKED/OPEN/**WAITING**/ACTIVE/PAUSED/DONE) + Aufgaben-Status ab. **WAITING** = Team-Schritt, der besetzt ist, aber die Mindestbesetzung (`minWorkers`) noch nicht erreicht hat und deshalb noch nicht läuft (Timer/„In Bearbeitung" erst ab `min` MA). Reine `deriveStepStatus(step)`-Funktion (ohne DB) + wiederverwendbares `stepStatusSelect`; `computeStepStatus`/`computeTaskStatus` holen die Daten in **einer** Abfrage (kein N+1)
- **`scheduler.ts`** – minütlicher node-cron-Tick: Feierabend-Pause, Arbeitsbeginn-Erinnerung, **Journal-Aufräumlauf** (`purgeOldJournals()` zur festen Uhrzeit `RETENTION_PURGE_TIME = "03:00"` – außerhalb der Arbeitszeit, geringe Last; **zusätzlich einmal beim Serverstart**, falls die Marke bei ausgeschaltetem Server verstrichen ist), Eskalations-Checks (nur in Arbeitszeit; **Referenzzeit ist `Step.availableAt`**, `null` = nie freigegeben → keine Eskalation. Früher ein Behelf aus dem letzten `Assignment.finishedAt` bzw. `task.startedAt` – der ließ spät freigeschaltete Schritte in der Sekunde ihrer Freigabe als überfällig gelten); pusht Eskalationen an qualifizierte MA, die **nicht** schon auf einer HIGH-Aufgabe aktiv sind (also auch an MA auf niedriger-prioren Schritten). **Die beiden uhrzeitbasierten Regeln (`workEnd`-Pause, `workStart`-Erinnerung) sind nur noch das Auffangnetz für MA OHNE Zeiterfassung** (`notClockManagedFilter()`: keine `crewmeisterUserId` **oder** manuell gepinnte Anwesenheit; ist Crewmeister gar nicht konfiguriert, gelten sie wie früher für alle). Wer gestempelt wird, wird von `presence.ts` unterbrochen/erinnert – sonst würde die Uhrzeit ihn mitten in der Arbeit unterbrechen, obwohl er noch eingestempelt ist, und morgens ein zweites Mal erinnern. Die Massen-Pause zieht jetzt auch `afterAssignmentChange` je Schritt nach (fehlte vorher – das Dashboard zeigte den Schritt danach weiter als laufend).
- **`quietHours.ts`** – **Pause**, in der die Eskalation schweigt. `isWithinQuietPeriod({ breakStart, breakEnd }, now?)` ist **pur**: liest nichts aus der DB, sondern bekommt die Werte übergeben – der Scheduler hat die Settings zu Beginn seines Ticks ohnehin geladen, es kostet also **keine zusätzliche Abfrage**, und die Grenzfälle bleiben ohne Prisma-Mock testbar (`now` injizierbar). **Alles, was „keine Pause" bedeutet, lässt den Alarm durchlaufen** (gleiche Zeiten = deaktiviert, Ende vor Beginn, unparsbare Werte): ein still verstummender Eskalations-Alarm wäre der teurere Fehler als eine Meldung zu viel. Getestet in `services/quietHours.test.ts` (12 Tests). **Historie:** stand zuerst als `QUIET_PERIODS` hart im Code – bewusst aufgegeben, weil Pausenzeiten sich im Betrieb ändern und ein Deploy dafür der falsche Weg ist.
- **`stepAvailability.ts`** – pflegt `Step.availableAt`. Drei Funktionen: `markAvailableSteps(taskId)` (alle jetzt OFFENEN Schritte einer Aufgabe stempeln – bei Pool-Eintritt/Restart/Wiederholung), `markStepAvailable(stepId)` (Einzelfall aus `handleStepUnlocks`, wenn der letzte Vorgänger fertig wird), `clearAvailability(taskId)` (Lauf-Ende bzw. Herausnehmen aus dem Pool). **Regel: nur setzen, nie überschreiben** – der `availableAt: null`-Guard macht die Aufrufe idempotent, sonst würde ein erneuter Durchlauf des Abschluss-Pfads die Wartezeit auf 0 zurücksetzen und Liegenbleiber unsichtbar machen. Getestet in `services/stepAvailability.test.ts` (8 Tests).
- **`journalRetention.ts`** – `purgeOldJournals()`: löscht TaskRuns, deren `finishedAt` vor dem Stichtag liegt (`WorkLog` hängt per `onDelete: Cascade` daran und verschwindet mit). Stichtag = **lokale Mitternacht von heute minus N Tagen** (gleiche Tagesgrenze wie der „heute"-Filter) – bei N = 30 bleibt ein heute fertiger Lauf also 30 Tage. `journalRetentionDays = 0` → sofortiger Ausstieg, es wird **nichts** gelöscht. Sendet bei tatsächlichen Löschungen **ein** Sammel-`JOURNAL_DELETED` (mit `reason: "retention"` + `days`), kein Event je Tag: das Frontend invalidiert darüber ohnehin den kompletten `stats`-Prefix. Aufgerufen aus `scheduler.ts` (03:00 + Start) und aus `PATCH /settings`. Details siehe Kernregel „Aufbewahrung der Tagesjournale".
- **`push.ts`** – Web Push (VAPID), „best effort": `sendPushToEmployees`, `notifyReleasedStep` (Regel 2), `notifyHighPriorityTask` (Regel 1), `notifyAssignmentOffer` (Manager-Angebot an einen bestimmten MA). **Empfänger-Regel** (Regel 1/2): qualifizierte MA, die **nicht bereits auf einer HIGH-Aufgabe** eingeloggt sind – d. h. freie **und** an niedriger-priorer Arbeit (damit sie umschwenken können); wer schon auf einer hohen Aufgabe ist, wird nicht gestört (`assignments none: ACTIVE auf step.task.priority=HIGH`). Fehlende Keys/Sendefehler scheitern nie einen Request; 404/410-Abos werden aufgeräumt.
- **`crewmeister.ts`** – Client der betrieblichen Zeiterfassung **Crewmeister** (v3-API, `.env` `CREWMEISTER_BASE_URL/USER/PASSWORD/CREW_ID`, JWT-Cache mit Refresh bei 401). Drei fachliche Funktionen: `getPresentUserIds()` (gerade eingestempelt, `stampStatus==OPEN` – Pausen zählen als anwesend), `getWorkingMinutes(from,to,userId?)` (Netto-Arbeitszeit je userId/Tag, nur `type==WORKING_TIME`; Ausreißer > 24 h/Tag werden gekappt), `getMembers()` (Mitgliederliste für die Zuordnung). „Best effort" wie Push: fehlt die Konfiguration, meldet `crewmeisterConfigured()` false; API-Fehler werfen `CrewmeisterError`, die der Aufrufer in eine sanfte Antwort übersetzt. **Alles Anbieter-Spezifische steckt nur in dieser Datei** – ein Wechsel der Zeiterfassung wäre eine neue Datei mit denselben drei Funktionen (Vendor-Namen stecken allerdings noch in `Employee.crewmeisterUserId`, der Route `/employees/crewmeister-members` und den Frontend-DTOs).
- **`presence.ts`** – Anwesenheits-Sync aus Crewmeister (minütlich im Scheduler): setzt `Employee.present` aus dem Live-Stempelstatus, aber **nur** für MA im Auto-Modus (`presenceOverride == null`) mit gesetzter `crewmeisterUserId`. Manuell gepinnte MA und solche ohne Zuordnung bleiben unberührt. Best effort (Crewmeister nicht erreichbar → nichts passiert, letzte Werte bleiben). **Am Wechsel hängt die Arbeitszeit-Erfassung:** ausstempeln unterbricht die laufenden Zuweisungen, einstempeln erinnert an die unterbrochenen – Details und Begründung siehe Kernregel „Anwesenheit". Importiert dafür `afterAssignmentChange`/`remindOwnInterruptedSteps` aus `routes/assignments.ts` (bewusst kein zweiter Nachbau; ein Verschieben dieser Helfer nach `services/` würde den ganzen Abschluss-Pfad `finalizeTask`/`handleStepUnlocks` mitziehen).

### Inaktive Zeit (MA-Detail-Auswertung)

Kennzahl „**Inaktiv (nicht eingeloggt)**" = gestempelte Arbeitszeit, die keinem LagerHub-Arbeitsschritt zugeordnet ist (Rüsten, Besprechungen, Wege – oder vergessenes Einloggen):

```
inaktiv(Tag) = max(0, Crewmeister-WORKING_TIME(Tag) − Σ LagerHub-Aktivzeit(Tag))
```

- **Netto gegen Netto:** `WORKING_TIME` ist bereits ohne Pausen (BREAK/PRESENCE sind eigene Typen) – die Mittagspause zählt **bewusst nicht** als inaktiv. LagerHub-Aktivzeit = `WorkLog.activeMs` = `finishedAt − startedAt − pausedMs` (Unterbrechungen abgezogen).
- **Die Pro-Tag-Tabelle listet die Vereinigung** aus Tagen mit abgeschlossenen Schritten **und** Tagen mit gestempelter Arbeitszeit. Ein eingestempelter Tag ohne fertigen Schritt erscheint damit als voller Leerlauf-Tag (0 Schritte / 0 min aktiv / volle Zeit inaktiv), statt aus der Auswertung zu fallen. Tage mit 0 Stempelminuten werden nicht aufgenommen.
- **Grenze (bewusst akzeptiert):** Schritt-Zeit entsteht erst beim Abschluss der **ganzen Aufgabe** (`finalizeTask` schreibt `WorkLog`). Zeit auf laufenden Aufgaben zählt bis dahin als inaktiv – die Kennzahl ist erst für einen **abgeschlossenen Tag** belastbar, für „heute" systematisch zu hoch.
- **Tageszuordnung** über `finishedAt`; ein über Mitternacht laufender Schritt zählt ganz auf den Folgetag (im Betrieb nicht relevant, nicht behandelt).
- Ohne Crewmeister-Zuordnung/-Konfiguration/-Erreichbarkeit bleiben die Inaktiv-Felder `null` (Anzeige „–" + Grund), der Rest der Auswertung funktioniert weiter.

---

## Design / Farbwelt (Branding)

Beide Apps teilen eine gemeinsame, an **inter-drive.de** angelehnte Marken-Palette (per CSS-Variablen in `frontend/src/styles.css` **und** `pwa/src/styles.css`, gleiche Rollen):

- **Navy `#212C3D`** (`--brand` im Dashboard, `--accent` in der PWA) = Marken-Grundton: Dashboard-Kopfbalken, PWA-Topbar, Primär-Buttons (`.btn--primary`), aktiver Tab-Text, Haupttext.
- **Gold `#EEC643`** (`--accent` im Dashboard, `--gold` in der PWA) = Akzent: aktive Tab-Unterlinie, Kopf-/Topbar-Akzentlinie (3 px unten), PWA-Angebots-Karte (`.step-row--offer`, Gold-Tint).
- Semantik-Farben bleiben **bewusst unverändert** (eigene Bedeutung): Prioritäts-/Status-Badges (rot/amber/grau/grün), Anwesenheits-Toggle (grün/rot), Fortschrittsbalken (grün = erledigt), Info-Banner (blau). Auf dem Navy-Kopf werden nur die Live-Status-Punkte aufgehellt (Kontrast).

> Regel auf **Gold**: nie Gold-Text auf Weiß (Kontrast < AA). Gold nur als Fläche/Linie/Rahmen mit **Navy**-Text (`--on-accent`). Navy trägt weißen Text.

**Gestaltungs-Tokens** (gleiche Struktur in beiden `styles.css`, Werte mobil leicht großzügiger): Radius-Skala `--r-sm/md/lg`, Schatten-Skala `--sh-xs/sm/md(/lg)`, Fokus-Ring `--ring`, Hover-Fläche `--hover`, kräftigerer Bedienelement-Rahmen `--border-strong`. **Prinzip: Tiefe über weiche Schatten statt harter Rahmen** – Rahmen bleiben, sind aber zurückgenommen, damit Tabellen und Karten ruhig wirken. Umgesetzte Muster:

- **Kopf/Topbar** mit Navy-Verlauf (`--brand-600` → `--brand`) + Schatten; die **PWA-Topbar ist `sticky`** (Verbindungsstatus/Abmelden immer erreichbar). Gold-Akzentlinie unten bleibt.
- **Aktiver Tab** = Gold-Balken via `::after` (2 px, bündig auf der Trennlinie) statt `border-bottom`.
- **Tabellen:** Spaltenköpfe klein/gesperrt in Versalien, Zeilen-Hover, `font-variant-numeric: tabular-nums` in `td` → Zahlenspalten fluchten. Gleiches `tabular-nums` in `.kpi__value`, damit Live-Werte nicht springen. **Abgerundete Ecken:** `table` nutzt `border-collapse: separate` + `border-spacing: 0` (nur so greift `border-radius`) mit dünnem Rahmen + `border-radius: var(--r-md)` + `overflow: hidden` (klippt die eckigen Kopf-/Fußzeilen-Ecken). Gilt global für alle Tabellen (Dashboard), nicht nur die Statistik.
- **Bedienelemente:** einheitlicher Rahmen/Radius für Felder und Buttons, `:focus-visible`-Ring (Tastatur), Druckpunkt beim Klicken (Dashboard `translateY(1px)`, PWA `scale(.98)` + kein Tap-Highlight). **Checkbox/Radio sind vom Feld-Styling ausgenommen** (`input:not([type="checkbox"]):not([type="radio"])`) – sonst würden sie zu Kacheln mit Rahmen und Innenabstand.
- **Badges** als weiche Pillen mit dünnem Innen-Ring (`box-shadow: inset 0 0 0 1px`) statt Vollfläche.
- **Karten-Staffelung (Aufgabe vs. Schritt):** Eine Aufgaben-Karte (`.task-card`, in **beiden** Apps) trägt bewusst mehr Gewicht als ihre Innen-Trennlinien – `--border-strong` + `--sh-md`, während Panels/Kacheln (`.card`) bei `--border` + `--sh-xs` bleiben. Dazu ist der Abstand **zwischen** Aufgaben (20 px) größer als der **zwischen** Schritten (12 px). Vorher waren Kartenrahmen und Schritt-Trennlinie identisch (`1px var(--border)`) und beide Abstände 12 px – dadurch las sich eine Liste aus zwei Aufgaben à zwei Schritten wie eine einzige durchlaufende Liste. Der Seitenhintergrund `--bg` ist dafür von `#f4f6f9` auf **`#e9edf3`** abgedunkelt (beide Apps identisch), sonst hätten weiße Karten nichts, wovon sie sich abheben. **Regel: Kontrast und Nähe staffeln die Ebenen – nicht der Einzelwert, sondern das Verhältnis außen/innen.** Im Dashboard hängt `.task-card` an der Pool-Karte (`tabs/PoolTab.tsx`); `.card` **nicht** mit anheben, sonst wird die kachelreiche Statistik zur Schattenwand.
- **Zeilen fluchten lassen – Raster statt `space-between`:** `.row` (Flex + `justify-content: space-between`) ist für Zeilen mit **festem** Inhalt gedacht. Wo Felder je nach Zustand erscheinen/verschwinden oder unterschiedlich lang sind, zieht space-between den Rest quer über die Breite auseinander. Zwei Werkzeuge dagegen:
  - **`.row--start`** (`justify-content: flex-start`) hält die Elemente links gepackt. Nötig z. B. in der Von/Bis-Zeile der Historie: dort ersetzt der kurze „Zurücksetzen"-Button nach dem Suchen einen langen Hinweistext – mit space-between sprangen die Datumsfelder dabei auseinander.
  - **Ein Grid**, wenn Angaben über **mehrere** Zeilen hinweg untereinander stehen sollen: `.journal-run__head` (Tagesjournal, feste Spalten `auto | 1fr | 52px | 88px | 1.3fr`, lange Namen mit Ellipse + `title`) und `.assignees` (Mitarbeiter-Spalte im Dashboard, `max-content max-content`). **Namensspalten als `max-content`, nicht als Pixelwert** – sie misst sich am längsten Eintrag statt an einer Schätzung. In Grid-Zellen brauchen Badges `justify-self: start`, sonst wird die Pille auf die Spaltenbreite gedehnt.
  - **Gleiche Breite für wechselnde Beschriftungen:** Buttons, deren Text sich mit dem Zustand ändert (`Unterbrechen`/`Fortsetzen`), bekommen eine `min-width` – sonst verschieben sie ihre Nachbarn von Zeile zu Zeile (`.assignee__actions .btn`, 118 px; ✓/✗ der Angebots-Zeile per `--icons`-Modifier wieder klein).
- **Aufklappende Menüs in Tabellen gehören in ein Portal.** Das `overflow: hidden` der Tabelle (siehe „Tabellen", nötig für die abgerundeten Ecken) **klippt jedes absolut positionierte Dropdown** aus einer `<td>` – bei den unteren Zeilen fast vollständig, das Menü war dort nicht bedienbar. Deshalb hängen Kebab-Menü (`components/KebabMenu.tsx`) und Fähigkeiten-Mehrfachauswahl (`SkillMultiSelect` in `tabs/EmployeesTab.tsx`) ihren Inhalt per `createPortal` an den `<body>` und positionieren ihn **`fixed`** über den gemeinsamen Hook **`components/useFloatingMenu.ts`**: Position aus dem Rechteck des Auslösers, **Umklappen nach oben**, wenn unten im Fenster kein Platz ist, Klemmen an den Fensterrändern, Reposition bei `resize`/`scroll` (capture – auch innere Scroller), Schließen bei Außenklick/Escape. `align: "right"` = rechtsbündig am ⋯, `"left"` = linksbündig unter dem Button. Vor der ersten Messung steht das Menü auf `visibility: hidden`, sonst blitzt es oben links auf. **Außenklick-Erkennung muss Auslöser UND Portal-Inhalt prüfen** – der Inhalt liegt nicht mehr im Wrapper. CSS: `.menu__dropdown` bleibt absolut (Grundaussehen), die Portal-Variante ergänzt `.menu__dropdown--float` (`position: fixed`, `right/top: auto`, `z-index: 100`); `.menu__dropdown` **nicht** global auf `fixed` umstellen.
- **Excel-Export-Buttons (`.btn--excel`)** in der Statistik: grün `#14804a` mit weißem Text (der dunkle Ton des Fortschrittsbalkens – 5:1 auf Weiß = AA; das hellere Erledigt-Grün `#16a34a` trägt weißen Text nicht). Bewusst **außerhalb** der Marken-Palette, damit der Export sich von den übrigen Bedienelementen abhebt. Alle vier (Tagesübersicht, Auslastung, Auswertung, MA-Detail) sind **linksbündig** und teilen `min-width: 220px` + das Beschriftungsmuster `⬇ Excel: <Was>` – Zeitraum/Details stehen im `title`, nicht in der Beschriftung (sonst wechselt der Button mit jedem Filter die Breite). **Deaktiviert** (keine Daten) fällt er auf Weiß zurück: die Signalfarbe soll nicht zu einem wirkungslosen Klick locken.
- `@media (prefers-reduced-motion: reduce)` schaltet alle Übergänge ab.

### Diagramm-Farben (`lib/chartColors.ts`)

Die Marken-Farben taugen **nicht** direkt als Datenflächen – nachgerechnet, nicht geschätzt: Navy `#212C3D` liegt bei OKLCH L 0.29 / **C 0.035** (zu dunkel *und* unter der Chroma-Grenze 0.10 → „liest sich als Grau"), Gold `#EEC643` bei L 0.84 mit **1.6:1** Kontrast auf Weiß (zu hell). Deshalb je Marken-Farbton eine abgeleitete Stufe, die den **Farbton hält** und nur Helligkeit/Chroma in den lesbaren Bereich rückt:

| Slot | Marke | Datenfarbe | Farbton-Abweichung |
|---|---|---|---|
| 1 | Navy H 258.9° | `#2c5aa0` (L 0.47, C 0.12) | 0.2° |
| 2 | Gold H 91.4° | `#a4861c` (L 0.63, C 0.12) | 0.2° |

Geprüft auf Helligkeitsband, Chroma-Untergrenze, Farbfehlsichtigkeit (protan/deutan/tritan) und Kontrast ≥ 3:1 – alle Checks bestanden, schlechtestes Paar ΔE 26.6 (Ziel ≥ 8). **Reihenfolge fest, nie durchrotieren.** Alle Diagramme der Auswertung haben genau **eine** Datenreihe und nutzen Slot 1; der Titel benennt sie, eine Legende entfällt. Marken-Spezifikation: Balken mit 4 px gerundeten Enden an der Grundlinie, Linien 2 px mit 8-px-Markern, Gitter nur waagerecht in `--border`, Achsen ohne Linien in `--muted`.

> **Kein Diagramm mit zwei y-Achsen.** „Durchsatz pro Tag" trug früher Läufe (links) und Ø Dauer (rechts) übereinander – durch die Wahl der beiden Skalen lässt sich damit jede beliebige Scheinkorrelation erzeugen. Jetzt zwei getrennte Diagramme mit je einer Reihe.

> Der **Auslastungstacho** nutzte bei geringer Auslastung ein Blau (`#2563eb`) außerhalb der Palette – jetzt **Navy** (neutral, kein Alarm); die aufgeklappte Kennzahl ist Gold-hinterlegt statt blau. Grün/Amber bleiben als Semantik-Farben. Die Bogenfarbe steht als **Hex** im Code, weil CSS-Variablen in SVG-Präsentationsattributen (`fill`/`stroke`) nicht aufgelöst werden.

**Logo** (`components/Logo.tsx` in beiden Apps): Inline-SVG-Wortmarke links im Kopfbalken/der Topbar – isometrischer „Lager"-Würfel (Gold-Deckelfläche + zwei Weißtöne für Tiefe) plus Schriftzug „Lager**Hub**" (Hub in Gold), darunter der kleine Urheber-Schriftzug „by Andinsky" (zweite Zeile; „by" gedämpft `.logo__by`, „Andinsky" in Gold `.logo__by-accent`; `.logo__word` ist dafür eine Spalte, die Wortmarke sitzt in `.logo__name`). Farben bewusst als Hex (Kontrast auf Navy), nicht über die Variablen. Dasselbe Würfel-Mark ist das **Favicon/App-Icon** (`public/icon.svg` in beiden Apps, Navy-Badge; `theme_color`/Manifest = Navy `#212c3d`).

## Frontend (Manager-Dashboard) – IST-Zustand

React 19 + Vite. Sechs Tabs (`App.tsx`, `TabId` in `api/session.ts`): **Dashboard, Aufgaben, Mitarbeiter, Statistik, Historie, Einstellungen** (der Dashboard-Tab nutzt intern `PoolTab.tsx`; welche Rolle welche sieht, steht in `TAB_ACCESS` – siehe „Rollen & Dashboard-Zugang"); Header zeigt den Live-Verbindungsstatus.

- **Dashboard (`tabs/PoolTab.tsx`)** – ganz oben der **Auslastungstacho** (`components/UtilizationGauge.tsx`), darunter drei Bereiche, aufgeteilt nach **`task.startedAt`** (nicht nach abgeleitetem Status): **In Bearbeitung** (`startedAt != null` – es wurde bereits ein Schritt begonnen; bleibt hier, auch wenn aktuell kein Schritt aktiv ist, z. B. ein Schritt erledigt + Rest offen), **Offen – noch nicht begonnen** (`startedAt == null`; hier gibt es je Aufgabe einen **„Aus Pool entfernen"**-Button = `poolEnabled=false`, um versehentlich gestartete Aufgaben wieder aus dem Dashboard zu nehmen – die Aufgabe bleibt unter „Aufgaben" erhalten; der Button verschwindet, sobald ein Schritt begonnen wurde), **Tagesjournal** (heute erledigt, aus `/stats/journal`; als aufklappbarer Baum via `components/JournalRunCard.tsx` – Aufgabe → Schritte → MA-Zeiten/Notizen). **In Bearbeitung** und **Offen** sind nach **Priorität** sortiert (HIGH zuerst, stabile Sortierung); jede Aufgaben-Karte trägt ein **Prioritäts-Badge** (`hoch`/`mittel`/`niedrig`, rot/amber/grau). Pro Schritt kann der Manager einen freien, **anwesenden**, qualifizierten MA einsetzen (Angebot; Abwesende erscheinen nicht in der Kandidatenliste). Ist der Schritt **voll besetzt** (aktive MA ≥ `maxWorkers`, gleiche Bedingung wie die Backend-Kapazitätsprüfung – nur ACTIVE zählt), wird statt Auswahl/„Einsetzen" der Hinweis **„● voll besetzt (n/n)"** gezeigt (kein Lauf in den 409). Jeder Bereich zeigt standardmäßig nur die ersten **3** Einträge mit fest reservierter Höhe (kein Springen) und einem „▾ Alle anzeigen"-Umschalter; Aufgaben-Karten sind eingeklappt (Schritte per Klick). Die **Mitarbeiter-Spalte** einer Schritt-Zeile ist ein Raster (`.assignees`): je MA eine Zeile, Namen und Schaltflächen jeweils in einer eigenen Spalte – bei zwei eingeloggten MA steht so alles untereinander. Pro Schritt gibt es eine ausklappbare **Notiz-Spalte** (`📝`), die den Notiz-Verlauf zeigt und das Anhängen erlaubt (Manager-Eintrag). **Erledigte** Schritte (DONE) eines laufenden Durchlaufs werden weiterhin angezeigt (ohne Einsetz-Steuerung, Status „erledigt"), damit auch dort Notizen ergänzt werden können. Oben erscheinen **Banner** für abgelehnte Angebote (`ASSIGNMENT_REJECTED`, gelb) und für **Erinnerungen an unterbrochene Schritte** (`WORK_REMINDER`, blau `alert--info`) – beide einzeln schließbar (Manager-Sicht; die PWA zeigt die Erinnerung parallel dem MA).
- **`lib/formatDuration.ts` – `formatMinutes()`, Zeitspannen-Anzeige.** **Regel: gerechnet und übertragen wird in ganzen Minuten, nur die Anzeige formt in Stunden + Minuten um.** `/stats` rundet alle Werte auf Minuten, der **Excel-Export schreibt genau diese blanken Zahlen** (Spaltenüberschrift „… (min)") – damit man in Excel damit rechnen kann; **den Export also nicht auf „1 h 16 min" umstellen**. Ausgabe: `45 min`, `1 h 16 min`, `2 h` (glatte Stunde ohne „00 min"), `–` für `null`/nicht-endlich; Minuten zweistellig, damit Werte in einer Spalte gleich breit bleiben. Genutzt in Statistik-KPI, Auswertungs-Tabellen, MA-Detail und Tagesjournal – **die einzige Stelle für dieses Format** (es stand vorher zweimal wortgleich im Code). Bewusst **kein** Dezimalstunden-Format („1,27 h"): das ist zum Rechnen, dafür gibt es den Export. **Diagramm-Achsen bleiben in Minuten** (eine durchgehende Einheit ist als Skala lesbarer), nur die Tooltips formatieren – `minutesTooltip` in `AnalyticsSection.tsx`. Die mitlaufenden Uhren der Auslastung (`1:05:09`, `formatClock` in `StatsTab.tsx`) sind davon unberührt.
- **`components/StepAge.tsx` + `lib/stepAge.ts` – Alter eines Arbeitsschritts („⏱ 42 min").** In **beiden** Apps als eigene Kopie (die PWA teilt keinen Code); die **Regeln müssen gleich bleiben**, sonst benennen Manager und MA denselben Schritt unterschiedlich. Drei Entscheidungen dahinter:
  - **Alter statt Uhrzeit.** „verfügbar seit 09:14" zwingt zum Kopfrechnen; gefragt ist die Differenz. Der exakte Zeitpunkt steht im `title`-Tooltip.
  - **Ampel aus `Settings.escalationMins`**, nicht aus einer eigenen Zahl: `< 50 %` grau, `50–100 %` amber, `≥ 100 %` rot – **derselbe** Schwellwert, auf den der Eskalations-Push feuert. Ein zweiter Wert hier hieße, dass Oberfläche und Backend Verschiedenes „zu lange" nennen (Anzeige grau, Push „überfällig"). Die PWA liest ihn über das jetzt `authAny`-lesbare `GET /settings`.
  - **Bezugspunkt je Status** (`stepAgeBasis`): OPEN/WAITING → `availableAt` („wartet seit", **mit** Ampel, das ist die Liegenbleiber-Frage); ACTIVE/PAUSED → `startedAt` („läuft seit", **ohne** Ampel – laufende Arbeit ist kein Liegenbleiber); DONE/LOCKED → keine Anzeige.
  - **`formatAge()` statt `formatMinutes()`** – eigene Stufe ab einem Tag (`9 d 2 h`); `formatMinutes` kennt nur Stunden und liefert „216 h 40 min". `formatMinutes` bleibt dafür unangetastet: es bedient Statistik und Excel-Export, wo Stunden die Einheit sind.
  - **Ein Takt pro Seite** (`lib/useNow.ts`, 30 s), nicht ein Timer je Zeile – reicht für eine Anzeige in ganzen Minuten und schont den Handy-Akku. `useNow` stand vorher lokal in `StatsTab.tsx` und ist jetzt gemeinsam.
- **`components/NotesPanel.tsx`** – wiederverwendbare Notiz-Verlaufsanzeige (Einträge `Zeit · Name (MA/Manager/Büro/Admin): Text`; der **Name kommt aus dem Token** – `noteAuthorFromUser` in `services/notes.ts`, genutzt für Schritt-Notizen, Pflichtnotiz und Historie-Nachtrag. Ältere Dashboard-Einträge tragen pauschal „Manager“) + Eingabe zum Anhängen (Strg+Enter). Genutzt im Dashboard (laufende Schritte) **und** in der Statistik-Historie. Einträge mit `kind: "COMPLETION"` (Pflichtnotiz) werden fett und mit Beschriftung gezeigt.
- **`components/CompletionNotePrompt.tsx`** – Eingabe der Pflichtnotiz beim Abschluss; in **beiden** Apps als eigene Kopie (die PWA teilt keinen Code). Enthält `isCompletionNoteValid` – muss dieselben Werte akzeptieren wie `validateCompletionNote` im Backend.
- **`components/AnalyticsSection.tsx`** – **Auswertung (Zeitraum)** im Statistik-Tab: Von/Bis-Auswahl mit „Suchen" (Default letzte 7 Tage); direkt darunter die **MA-Tabelle** (aktive Minuten/Schritte/Aufgaben/Ø je Schritt). Darunter die einklappbare Sektion **„Ø Zeit je Arbeitsschritt"** (Sub-Komponente `StepDurationsSection`, standardmäßig zu; aus `useStepDurations`): **Dropdown „Aufgabe"** (Default „Alle Aufgaben") filtert die Tabelle *Aufgabe · Schritt · Ø Zeit · Vorkommen · Kürzeste · Längste* (bei „Alle" nach Ø-Zeit absteigend + Aufgabe-Spalte; bei Auswahl nur deren Schritte); dazu ein horizontales Balkendiagramm. Darunter die **Diagramme als einzeln aufklappbare Liste** (standardmäßig zu): aktive Zeit je MA, übernommene Schritte je MA, Ø Dauer je Aufgabentyp (**Recharts**). Die früheren Tages-Diagramme **„Durchsatz pro Tag (Läufe)"** und **„Ø Dauer pro Tag"** wurden auf Wunsch **entfernt** (die neue Schritt-Auswertung ist aussagekräftiger); `/throughput` wird nur noch fürs Excel-Blatt „Durchsatz pro Tag" genutzt. Daten aus `useEmployeeHistory`/`useThroughput`/`useStepDurations` (Keys mit Prefix `stats` → bei `TASK_COMPLETED` mit-invalidiert). **Excel-Export (`lib/statsExport.ts`, SheetJS):** je nach Filter **eine** Mappe – „Alle" → 4 Blätter (MA-Auswertung, **Ø je Arbeitsschritt**, Durchsatz pro Tag, Ø je Aufgabentyp); einzelner MA → Detail-Mappe (5 Blätter, in `EmployeeDetailSection`). Übernimmt den gewählten Von/Bis-Zeitraum (auch im Dateinamen).
- **`components/JournalRunCard.tsx`** – gemeinsame **Tagesjournal-Darstellung** für Dashboard **und** Statistik-Historie (damit beide identisch sind). Baum: **Aufgabe** zugeklappt (nur Name · Uhrzeit · Dauer · beteiligte MA, ▸/▾) → beim Aufklappen die **Schritte mit ihrer Dauer** → je Schritt die `workers`. **Zeiten:** die Schritt-Dauer (`steps[].durationMinutes`, `services/journalDuration.ts`) ist die am Schritt gearbeitete Zeit – Team-Zeit **einmal** (Abschnitte werden vereinigt), Unterbrechungen raus, Wartezeit vor dem Team-Timer raus (`Step.startedAt` steht dafür seit 10/2026 im Snapshot; ältere Läufe zählen ab Einloggen). Die Zeit im Kopf ist die **Summe der gerundeten Schritt-Dauern**, damit sie beim Aufklappen genau aufgeht – **nicht** mehr die Wanduhr `Ende − Start`, die Liegezeiten zwischen Schritten und Nächte mitzählte. Nur das Journal ist umgestellt; Statistik-KPI „Ø Dauer“ und `/throughput` rechnen weiter Wanduhr (MA mit Einzel-Netto-Zeit, `Name · 25 min`; die Unterbrechungs-**Dauer** wird bewusst NICHT mehr angezeigt). Die **Kopfzeile ist ein Raster** (`.journal-run__head`), damit Aufgabe/Uhrzeit/Dauer/MA über alle Durchläufe hinweg untereinander fluchten – vorher lief sie über `.row` und zog die Felder je nach Textlänge auseinander (siehe „Design", Abschnitt Zeilen/Raster). Schritt-**Notizen** stecken pro Schritt hinter dem `📝`-Button (mit Anzahl), Nachtragen via `POST /stats/journal/:runId/notes`.
- **Aufgaben (`tabs/TasksTab.tsx`)** – Anlegen/Bearbeiten, Schritt-Verwaltung, Kopieren/Löschen. **Aufgaben sortieren per Drag & Drop** am Griff ⠿ im Kartenkopf (nicht an der ganzen Karte – darin stecken die ebenfalls ziehbaren Schritt-Zeilen; abgelegt wird auf der ganzen Karte, ausgewertet nur, wenn eine **Aufgabe** gezogen wird). `useReorderTasks` ist optimistisch, bei Fehler wird neu geladen. Die Priorität sortiert hier **nicht** mehr; Dashboard/PWA sortieren weiter nach Priorität und nehmen die Reihenfolge nur als Gleichstand. **Schritte sortieren: nur Drag & Drop** (⠿). **Neuer Schritt:** Fähigkeit über `SkillSelect` (Einfachauswahl mit Suche + „Neu anlegen"). **Schritt bearbeiten** öffnet eine Box über die volle Tabellenbreite (Raster `Beschriftung | Feld`, Pflichtnotiz als letzte Zeile) – Details siehe „Offene Punkte", Eintrag „Aufgaben-Tab aufgeräumt". **„Starten"** stellt die Aufgabe in den Pool (`poolEnabled=true` + `restart`) – mit **Inline-Bestätigung** statt blockierendem `confirm()` (ein gesperrter Browser-Dialog konnte den Start sonst verschlucken; `onError` macht Fehler sichtbar). Ist die Aufgabe bereits im Pool, wird „Starten" **ausgeblendet** und stattdessen „● im Pool" angezeigt. **Kartenkopf-Layout:** der Aufgabenname wächst (`flex:1`) und ankert den Steuerungsblock (Priorität/Schritte/Wiederholen/Starten) am **rechten Rand**; Prioritäts-Select und „Schritte (n)"-Button haben **feste Breiten** und „Starten/● im Pool" sitzt in einem festen Slot – so fluchten die Felder über alle Karten hinweg untereinander (statt je nach Namenslänge zu springen). Die **Start-Bestätigung** erscheint als eigene **Leiste unter dem Kopf** (nicht inline im Slot), damit der Kopf beim Klick auf „Starten" stabil bleibt.
- **Statistik (`tabs/StatsTab.tsx`)** – KPIs/Auslastung (Live-Tabelle mit **mitlaufender Uhr** via `useNow`-Sekundentakt: MA · aktuell bearbeitete Aufgabe/Schritt · Zeit auf der aktuellen Zuweisung · heutige Netto-Gesamtzeit), mit **Excel-Buttons** (`lib/statsExport.ts`, Stil `.btn--excel`): „Tagesübersicht" (KPIs + Aufgaben nach Status) und „Mitarbeiter-Auslastung". Darunter die **Auswertung (Zeitraum)** (`AnalyticsSection`) und das **MA-Detail** (`EmployeeDetailSection`). Die **Tagesjournale sind hier nicht mehr drin** – sie haben einen eigenen Tab (siehe unten); im Code steht an ihrer Stelle nur noch ein Verweis-Kommentar.
- **Historie (`tabs/HistoryTab.tsx`)** – **eigener Tab**, nicht mehr ein Abschnitt der Statistik: so sieht das **Büro** (OFFICE) die Tagesjournale, **ohne** die restliche Statistik zu bekommen (die Statistik bleibt ADMIN-Sache). Inhalt: Tage aus `/stats/journal/days`, je Tag aufklappbar (lädt `/stats/journal?date=…`); die Durchläufe rendert dieselbe `JournalRunCard` wie im Dashboard (Baum: Aufgabe → Schritte → MA-Zeiten + Notizen). Standardmäßig nur die **letzten 5** Tage (`JOURNAL_DAYS_LIMIT`), ältere über die Von/Bis-Auswahl – die **erst auf „Suchen" greift**, nicht schon beim Tippen ins Datumsfeld (ein halb getipptes Datum würde sonst die Liste leeren). Manager/Admin können Notizen nachtragen und ganze Tage löschen (nur Vergangenheit, mit Rückfrage) – der **Löschen-Knopf ist an `isManager` gebunden**, weil `DELETE /stats/journal/:date` serverseitig `authManager` ist; für OFFICE lief er vorher sichtbar in einen 403. Die Karte „Automatische Löschung" saß früher hier (`RetentionControl`) und steht jetzt im **Einstellungen-Tab** – sie ist ein Betriebsparameter, keine Tagesansicht.
- **Einstellungen (`tabs/SettingsTab.tsx`)** – **nur ADMIN** (`TAB_ACCESS`; serverseitig `authAdmin` auf `PATCH /settings`). Vier Karten, jede mit eigenem Entwurf und eigenem „Speichern": **Arbeitszeiten** (`workStart`/`workEnd`), **Eskalation** (`escalationMins`), **Pause** (`breakStart`/`breakEnd`) und **Automatische Löschung** (`journalRetentionDays`, aus dem Historie-Tab hierher gezogen). Entscheidungen dahinter:
  - **Je Karte ein Speichern-Knopf**, nicht einer für alles: ein abgelehnter Wert (z. B. verdrehte Pausenzeiten) soll nicht die nebenbei geänderten Arbeitszeiten mitreißen. Der Fehler wird nur an der auslösenden Karte gezeigt (`failed`-State) – sonst erschiene die Meldung der Pause unter den Arbeitszeiten.
  - **`key={JSON.stringify(settings)}`** auf `SettingsForms`: kommt über WS `SETTINGS_UPDATED` ein fremder Stand herein, werden die Entwurfs-States neu aufgebaut. Ohne das zeigte das Formular weiter den alten Wert und „Speichern" bliebe grundlos aktiv (das war die Schwäche des `useEffect`-Musters im alten `RetentionControl`).
  - **Jede Karte erklärt die Wirkung im Klartext** darunter – die Werte steuern Push-Verhalten und Datenlöschung, das ist nichts zum Raten. Die Lösch-Karte benennt ausdrücklich, dass die Auswertungs-Daten mit verschwinden und es unumkehrbar ist.
- **`components/UtilizationGauge.tsx`** – SVG-Halbkreis-Tacho. Rechnet **rein im Frontend** aus `pool`- und `employees`-Daten (kein eigener Endpoint): Personalauslastung (anwesende MA im Einsatz ÷ anwesende), Schritt-Besetzung (besetzt/offen/pausiert), „sofort besetzbar" (freie passende Kraft vorhanden) vs. „Engpass" (inkl. fehlender Fähigkeiten). Live über WS-Invalidierung. **Jede Kennzahl ist ein Button** – ein Klick klappt darunter (volle Breite) die passende **Detailliste** auf (nochmal klicken schließt, aktiver Chip hervorgehoben): Personen-Zahlen → MA-Liste (im Einsatz mit aktueller Aufgabe/Schritt aus `Employee.currentStep`, frei mit Fähigkeiten), Schritt-Zahlen → Liste „Aufgabe / Schritt". Funktioniert für alle Dashboard-Rollen (kein Tab-Wechsel).
- **`api/client.ts`** – schlanker Fetch-Wrapper auf relative `/api`-URLs (Dev über Vite-Proxy, Prod gleicher Origin); behandelt leere 204-Antworten, wirft bei `!res.ok`. **Hängt das Session-JWT als `Authorization: Bearer …` an und fängt 401 ab** (Session verwerfen → Login). Gleiche Logik in der PWA (`pwa/src/api/client.ts`).
- **`api/queries.ts`** – zentrale `queryKeys` + TanStack-Query-Hooks (Queries + Mutations). REST ist die Quelle der Wahrheit; Mutations invalidieren die betroffenen Keys. **Ausnahme:** die Assignment-Mutationen (offer/accept/reject/pause/resume/complete) invalidieren **nicht** selbst – das WS-Event übernimmt das (sonst doppelte Refetches).
- **`api/useRealtime.ts`** – WebSocket an `/ws` mit Auto-Reconnect (2 s). **Verbindet mit dem JWT als Query-Param (`/ws?token=…`) und nur, wenn angemeldet** (das Token ist Pflicht; Server schließt sonst mit Code 1008). Der Socket ist **nur Signal**: ein Event invalidiert via `EVENT_MAP` die betroffenen Query-Keys, es wird **nichts** aus dem Payload in den State gepatcht. Invalidierungen werden in einem **200-ms-Fenster gebündelt** (`scheduleInvalidate`), damit ein Burst mehrerer Events (z. B. bei „Annehmen") nur eine Refetch-Welle je Key auslöst.
- **`api/types.ts`** – DTO-Typen, spiegeln die Backend-Antworten.

> Architektur-Prinzip Frontend: REST liefert Daten, WS invalidiert nur Caches. Beim Erweitern eines Backend-Events ggf. `EVENT_MAP` in `useRealtime.ts` ergänzen.

---

## PWA (Mitarbeiter-App) – IST-Zustand

Eigenständige React-19-+-Vite-6-App unter `pwa/` (Port 5174), mobile-first, teilt vorerst **keinen** Code mit dem Manager-Frontend (eigene schlanke `api/`-Schicht). Dev-Server proxyt `/api` + `/ws` selbst ans Backend (Same-Origin-Prinzip wie in Produktion). Meilensteine:

- **M0/M1 – Login (`components/LoginScreen.tsx`, `api/session.ts`):** PIN-Login mit **Gerätebindung** (`POST /employees/login`, `deviceId` dauerhaft in `localStorage`). PIN-Feld ist ein **Passwortfeld** (Schulterblick-Schutz). Die `deviceId` wird über `generateUuid()` erzeugt – `crypto.randomUUID` nur im Secure Context (localhost/HTTPS), sonst Fallback über `crypto.getRandomValues` (nötig beim LAN-Test über `http://<IP>` am Handy).
- **M2 – Arbeitsansicht (`components/PoolList.tsx`):** die nach Fähigkeiten gefilterten, freigegebenen Schritte (aus `/api/pool?employeeId=`). Aufgaben sind in **zwei Blöcke** gruppiert: **„Meine Arbeit"** (aktive Aufgabe oben, unterbrochene direkt darunter, mit farblichem Kartenakzent grün/gelb) und optisch abgesetzt **„Verfügbare Aufgaben"** – Einordnung pro Aufgabe anhand der eigenen Zuweisung (`classifyTask`: ACTIVE/PAUSED/offen); je Block nach **Priorität** sortiert (HIGH zuerst, stabil). Jede Aufgabe trägt ein **Prioritäts-Badge** (`hoch`/`mittel`/`niedrig`). Aktionen je Schritt: **Einloggen**, **Abschließen**, **Unterbrechen**, **Fortsetzen**; bei einem noch nicht gestarteten Team-Schritt (WAITING) statt Abschließen/Unterbrechen ein **„Ausloggen"** (`/leave`, auch aus dem PAUSED-Zustand – Team-Schritt ist vor Start nicht abschließbar). Voll besetzte Schritte zeigen den Hinweis statt Einloggen.
- **Alter je Schritt:** rechts in der Schritt-Zeile „⏱ 42 min" (`components/StepAge.tsx`) – auf dem schmalen Display bewusst **rechts vor der Notiz-Schaltfläche**, links würde es den Schrittnamen umbrechen. Regeln siehe Dashboard-Abschnitt.
- **Pflichtnotiz:** Verlangt ein Schritt eine Angabe, heißt der Knopf `Abschließen 📝` und klappt statt des Abschlusses die Eingabe auf (`components/CompletionNotePrompt.tsx`, gold umrandet unter der Zeile – bewusst **kein** Overlay: ein Modal verdeckt am Handy die Zeile, um die es geht, und die Tastatur schiebt es weg). Zahl-Felder nutzen `inputMode="decimal"` statt `type="number"` (der Zahlen-Typ verschluckt in manchen Browsern das Komma). Regeln siehe Kernregel „Pflichtnotiz beim Abschluss".
- **M3 – Angebote + Notizen:** Manager-Angebote **annehmen/ablehnen** (`accept`/`reject`), MA-**Notizen** anhängen (`components/NotesPanel.tsx`, `POST /steps/:id/notes`; Autor kommt aus dem Token).
- **Meldungen (`components/Notices.tsx`, früher `WorkReminders.tsx`):** schließbare Banner über der Arbeitsansicht für alles, was dem MA **von außen** zustößt – beides über den Roh-Event-Verteiler `onRealtimeEvent` (nicht über die Query-Invalidierung) und auf die eigene `employeeId` gefiltert: **`WORK_REMINDER`** (du hast anderswo noch etwas unterbrochen; blau) und **`ASSIGNMENT_WITHDRAWN`** (die Aufgabe wurde zurückgezogen, du bist ausgeloggt; amber `.reminder--withdrawn` – ein anderer Ton, weil hier jemand anderes in die eigene Arbeit eingegriffen hat). Ein Banner je **Schritt und Art** (`key = kind:stepId`), damit die eine Meldung die andere zum selben Schritt nicht überschreibt.
- **`api/useRealtime.ts`:** WS-Signal → invalidiert den `pool`-Key (200-ms-Bündelung); zusätzlich modulweiter `onRealtimeEvent`-Verteiler für Payload-Reaktionen (Erinnerung). **`api/queries.ts`/`client.ts`:** Assignment-Mutationen ohne self-invalidate (WS übernimmt), wie im Dashboard.
- **M4 – Web-Push (`src/sw.ts`, `api/push.ts`, `components/PushToggle.tsx`):** VitePWA auf **injectManifest** (eigener SW mit `push`/`notificationclick`-Handlern; SW aus dem tsc-Typecheck ausgenommen, `workbox-precaching` fürs App-Shell-Precaching). `PushToggle` fragt die Berechtigung an (Nutzer-Geste), abonniert via `PushManager.subscribe` mit dem VAPID-Key (`GET /push/vapid-public-key`) und meldet das Abo an `POST /push/subscribe` (employeeId aus dem Token); beim Abmelden wird es entfernt. **Nur im Secure Context** (HTTPS/localhost). Dev-Test: `npm run test:push -- <MA-Name>` (Backend) schickt einen echten Push an die gespeicherten Abos eines MA.

---

## Kernregeln (Geschäftslogik)

### Rollen & Dashboard-Zugang
Anmeldung am Dashboard per 4-stelligem PIN (`/pin-login`); die PWA per PIN + Gerätebindung (`/employees/login`). Beide Endpunkte liefern ein **signiertes JWT** (`{ sub, role, name }`, Laufzeit 12 h), das der Client in `localStorage` (`SessionUser`/`MaUser`) hält und bei **jeder** Anfrage im `Authorization: Bearer …`-Header mitschickt (siehe `auth.ts` unter „Auth"). Die Rolle steuert **zusätzlich** die sichtbaren Tabs (`TAB_ACCESS` in `frontend/src/api/session.ts`) – die Tab-Filterung ist reiner Komfort, die **echte** Absicherung sind die serverseitigen Rollen-Guards.

| Rolle | Tabs | Zugang |
|---|---|---|
| **ADMIN** | Dashboard, Aufgaben, Mitarbeiter, Erinnerungen, **Statistik**, Historie, **Einstellungen** (alles) | **geheime PIN** aus `ADMIN_PINS` (kein MA-Datensatz) |
| **MANAGER** | Dashboard, Aufgaben, Mitarbeiter, Erinnerungen, Historie (**ohne** Statistik und Einstellungen) | MA mit `role=MANAGER` |
| **OFFICE** (Büro) | Dashboard, Aufgaben, Erinnerungen (nur entscheiden), Historie | MA mit `role=OFFICE` |
| **WORKER** (Lager) | — (nutzt die PWA) | MA mit `role=WORKER` |

ADMIN ist bewusst **keine** Mitarbeiter-Rolle: die PINs liegen nur in der `.env` (`ADMIN_PINS`, Format `"PIN:Name,…"`), `adminPins.ts` parst sie, `/pin-login` erkennt sie vor der MA-Suche. Reservierte Admin-PINs werden nicht an Mitarbeiter vergeben. ADMIN erbt im Historie-Tab die Manager-Rechte (Nachtragen/Tage löschen). ADMIN hat kein DB-/MA-Rollen-Enum (Prisma-`Role` = MANAGER/OFFICE/WORKER), existiert aber als Token-Rolle (`AuthRole` in `auth.ts`).

### Auth & Autorisierung (`auth.ts`)
Zustandsloses **JWT** (`@fastify/jwt`, Secret `JWT_SECRET` – Fail-fast ohne). Guards als `preHandler` je Route: **`authAny`** (jedes gültige Token), **`authDashboard`** (OFFICE/MANAGER/ADMIN), **`authManager`** (MANAGER/ADMIN), **`authAdmin`** (ADMIN, u. a. `PATCH /settings`) – 401 ohne/ungültiges Token, 403 bei falscher Rolle. Öffentlich bleiben nur `/employees/pin-login`, `/employees/login`, `/push/vapid-public-key`, `/health`. **Identität kommt aus dem Token, nicht aus dem Body:** `POST /assignments` (Selbst-Login) und `/push/subscribe` nehmen `employeeId` aus `req.user.sub`; `/steps/:id/notes` leitet den Autor aus der Rolle ab (WORKER → MA-Notiz, sonst Manager); `GET /pool` zwingt einen WORKER auf die eigene Identität (Dashboard-Rollen sehen frei). **WS `/ws`** verlangt das Token als Query-Param (`?token=…`, da Browser-WS keinen Header setzen kann) → ungültig = Close 1008. **CORS** per `CORS_ORIGIN` einschränkbar. Client-Seite: der eine `request()`-Wrapper je App hängt den Header an und fängt **401** ab (Session verwerfen → Login); alte tokenlose Sessions gelten als abgemeldet.

### Vorgänger-Logik
Ein Schritt ist freigegeben, wenn **alle** Vorgänger DONE sind, sonst LOCKED. Gesperrte Schritte erscheinen nicht im Pool. Standard: neuer Schritt erhält letzten Schritt als Vorgänger.

### Verfügbarkeits-Uhr (`Step.availableAt`) – „wie lange liegt das schon da?"

**Der Zeitpunkt der Freigabe hinterlässt sonst keine Spur.** Er hängt an zwei Ereignissen (Pool-Eintritt, Abschluss des letzten Vorgängers) und ist aus `Assignment`-Zeiten nicht rekonstruierbar – deshalb eine eigene Spalte statt einer Ableitung. Gepflegt ausschließlich über `services/stepAvailability.ts`:

| Ereignis | Wirkung |
|---|---|
| Aufgabe kommt in den Pool (`poolEnabled` false→true, `POST /:id/restart`) | `markAvailableSteps` stempelt die jetzt **offenen** Schritte |
| Letzter Vorgänger wird fertig (`handleStepUnlocks`) | `markStepAvailable` stempelt genau diesen Nachfolger |
| Aufgabe wird abgeschlossen (`finalizeTask`) / neu gestartet | zurück auf `null`; bei **`repeat`** direkt danach neu stempeln (der neue Lauf ist ab jetzt abholbar) |
| Aufgabe verlässt den Pool (`poolEnabled` true→false) | `clearAvailability` – ein nicht abholbarer Schritt hat keine Wartezeit, und beim Wiedereinstellen wäre der alte Wert ein zu hohes Alter |

**Reihenfolge beachten:** „Starten" im Dashboard ist `PATCH poolEnabled=true` **+** `restart`. Deshalb stempelt `restart` **nach** seinem eigenen Zurücksetzen – in der umgekehrten Reihenfolge hätte das `updateMany` die gerade gesetzten Zeitpunkte wieder gelöscht.

**Zwei Nutzer der Spalte:**
1. **Anzeige** in PWA und Dashboard (`components/StepAge.tsx`, Regeln in `lib/stepAge.ts`).
2. **Eskalation** (`scheduler.ts`) – ersetzt den alten Behelf; `null` = nicht eskalieren.

**Grenze (bewusst):** Die Migration backfillt nur die zum Migrationszeitpunkt offenen Schritte mit `now()`. Die Wartezeit **vor** der Einführung ist nicht rekonstruierbar (genau deshalb gibt es die Spalte) – die Uhr startet dort bei 0 und ist ab dem nächsten Lauf exakt.

### Team vs. Einzel
- **Team (min ≥ 2):** Timer (`Step.startedAt`) startet erst bei `min` qualifizierten MA; einer schließt für alle ab. Solange besetzt, aber `min` noch nicht erreicht und der Timer nicht gestartet → Status **WAITING** (die Aufgabe bleibt unter „Offen – noch nicht begonnen"). **Abschließen erst ab Start:** `complete` weist einen Team-Schritt mit `startedAt === null` (WAITING) mit **409** ab – so kann kein einzelner MA einen wartenden Team-Schritt allein beenden (Backend-Guard; die PWA zeigt im PAUSED-Fall dann „Ausloggen" statt „Abschließen").
- **Einzel (min leer/1):** Jeder loggt sich selbst ein, schließt eigene Zuweisung ab. Schritt DONE, wenn letzte aktive Zuweisung fertig. Bei einem Einzel-Slot-Schritt (`maxWorkers === 1`) schließt der Abschluss durch einen Übernehmer auch die noch unterbrochene Zuweisung des Vorgängers mit ab (siehe `assignments.ts`).

### Aufgaben-Abschluss (Standard: kein Auto-Neustart)
Ist die letzte Zuweisung fertig → `finalizeTask` (in `assignments.ts`): schreibt den `TaskRun`-Snapshot (Historie/Journal), löscht die Lauf-Zuweisungen, setzt Schritt-Timer zurück und die Aufgabe auf `OPEN`. **Standard:** `poolEnabled` wird auf `false` gesetzt – die Aufgabe verschwindet aus dem Pool/Dashboard und wird **nicht** automatisch neu gestartet; ein neuer Lauf kommt über die **Aufgaben-Maske** („Starten" → `poolEnabled = true`). **Ausnahme „Wiederholen" (`task.repeat`):** `poolEnabled` bleibt `true`, die Aufgabe steht (dank `startedAt = null`) sofort wieder als offener Lauf im Pool – zusätzlich `TASK_RESTARTED`, damit Dashboard/PWA aktualisieren.

### Aufbewahrung der Tagesjournale (`Settings.journalRetentionDays`)

Die `TaskRun`-Historie wächst mit jedem Durchlauf und wird nie kleiner. Damit sie nicht unbegrenzt anwächst, gibt es eine **einstellbare Aufbewahrungsdauer** in Tagen (`Settings.journalRetentionDays`, Migration `add_journal_retention`), gepflegt in der Karte „Automatische Löschung" im **Historie-Tab** (nur MANAGER/ADMIN).

| Entscheidung | Warum |
|---|---|
| **Default `0` = deaktiviert** | Löschen ist nicht rückgängig zu machen. Eine Voreinstellung, die ungefragt Historie entsorgt, wäre die falsche Richtung – der Betrieb muss die Dauer bewusst setzen |
| Stichtag = **lokale Mitternacht** von heute minus N Tagen | dieselbe Tagesgrenze wie der „heute"-Filter und `localDayKey`; bei einer reinen `now − N·24 h`-Rechnung hinge das Ergebnis an der Uhrzeit des Laufs |
| Löschen über **`TaskRun`**, nicht über `WorkLog` | `WorkLog.runId` hat `onDelete: Cascade` – die Auswertungs-Zeilen verschwinden automatisch mit. Andersherum bliebe der Snapshot ohne Auswertung übrig |
| **Ein** Sammel-`JOURNAL_DELETED` statt eines Events je Tag | die Clients invalidieren darüber ohnehin den ganzen `stats`-Prefix; N Events wären N Refetch-Wellen |
| `PATCH /settings` räumt bei geändertem Wert **sofort** auf | sonst passiert nach dem Speichern sichtbar nichts, bis irgendwann nachts der Lauf greift |

**Zwei Auslöser:** der Scheduler um **03:00** (`RETENTION_PURGE_TIME`, außerhalb der Arbeitszeit) **plus einmal beim Serverstart** – lief der Server um 03:00 nicht, wäre der Lauf sonst ersatzlos ausgefallen. Beides landet in `services/journalRetention.ts`; der Aufruf ist idempotent (bei `0` oder ohne Treffer passiert nichts).

**Grenze (bewusst):** Die Aufbewahrung greift auf **ganze Läufe**, nicht auf einzelne Kennzahlen – mit dem `TaskRun` verschwinden auch dessen `WorkLog`-Zeilen, die Auswertung wird für den Zeitraum also leer. Wer die Historie länger auswerten will, setzt die Dauer höher; einen Aggregat-Restbestand („Zahlen behalten, Notizen löschen") gibt es nicht.

### Team-Schritt vor Beginn verlassen
Loggt sich ein MA in einen Team-Schritt ein, der die Mindestbesetzung noch nicht erreicht hat (Status WAITING, Timer nicht gestartet), kann er ihn über **„Ausloggen"** (`POST /assignments/:id/leave`) wieder verlassen – die Zuweisung wird **gelöscht** (Platz frei, keine Arbeitszeit gebucht), gedacht für Team-Umbesetzung vor Beginn. Sobald der Timer läuft, ist Verlassen nicht mehr möglich (dann unterbrechen/abschließen).

### Race Condition
Prüfen + Belegen atomar via PostgreSQL-Zeilensperre (`FOR UPDATE`). Abgelehnte MA: „Schritt gerade voll (z. B. 3/3)".

**Eine Zuweisung je (MA, Schritt).** Unter derselben Sperre prüft `activateOnStep`
zusätzlich, ob der MA auf **diesem** Schritt schon eine Zuweisung in `OFFERED`,
`ACTIVE` oder `PAUSED` hat – wenn ja: **409**. `DONE`/`REJECTED` sind ausgenommen
(nach Abschluss oder Ablehnung darf derselbe MA den Schritt erneut übernehmen), und
beim Annehmen wird das eigene Angebot ausgenommen (`promoteAssignmentId`), sonst
liefe das Annehmen gegen sich selbst.

> Ohne diese Prüfung legte **jeder weitere Login eine zweite Zuweisung an**: der MA
> belegte mehrere Plätze eines Schritts, und `finalizeTask` schrieb **zwei
> WorkLog-Zeilen für eine Person auf einem Schritt** – die Auswertung zählte den
> Schritt doppelt und addierte die Zeiten. Der übliche Weg dorthin war harmlos:
> unterbrechen und danach „Einloggen" statt „Fortsetzen" drücken (→ `PAUSED` +
> `ACTIVE`, und das sogar auf einem Schritt mit `maxWorkers: 1`, weil `PAUSED` nicht
> zur Kapazität zählt). `POST /offer` kannte die Regel bereits – der Selbst-Login
> nicht. Die Oberflächen zeigen „Einloggen" ohnehin nur ohne eigene Zuweisung; der
> 409 ist der Rückfall für veraltete Listen, Doppeltipp und zweites Gerät.

### Anwesenheit
Nur **anwesende** MA (`present=true`, nicht gelöscht) dürfen arbeiten. Geprüft in `activateOnStep` (Selbst-Login + Annehmen), in `POST /offer` **und in `POST /:id/resume`** (Fortsetzen) – geprüft wird jeweils der **MA der Zuweisung**, nicht der Handelnde, ein Manager kann also auch nicht für einen Abwesenden fortsetzen.

**Stempeln steuert die Arbeitszeit (`services/presence.ts`).** Der minütliche Sync setzt nicht nur `Employee.present`, er reagiert auf den **Wechsel**:

| Übergang | Folge |
|---|---|
| **abwesend** (`true → false`) | Alle `ACTIVE`-Zuweisungen des MA → `PAUSED`, `pausedReason: END_OF_DAY`, `pausedAt = jetzt`. Danach `afterAssignmentChange` je Schritt (Status ableiten, `ASSIGNMENT_CHANGED`, ggf. `TEAM_UNDERSTAFFED`). |
| **anwesend** (`false → true`) | `remindOwnInterruptedSteps` → `WORK_REMINDER` je unterbrochenem Schritt + Best-Effort-Push. Der MA sieht beim Arbeitsbeginn, wo er gestern stehengeblieben ist (Banner in PWA und Dashboard). |

Beide Folgen stecken in **`handlePresenceTransition(employeeId, nowPresent)`** (`services/presence.ts`) und werden von **zwei** Auslösern genutzt: dem Stempel-Sync und dem manuellen Schalter.

**Die manuelle Anwesenheit löst dasselbe aus.** Der Schalter im Mitarbeiter-Tab (`PATCH /employees/:id` mit `present` + `presenceOverride`) ruft nach einem **echten Wechsel** (vorher ≠ nachher) dieselbe `handlePresenceTransition()` auf – ohne das wäre er ein Schlupfloch: „auf abwesend stellen" hätte die laufende Arbeit weiterlaufen und die Zeit weiterzählen lassen. Best effort, ein Fehler im Nachlauf scheitert das Speichern nicht.

**Vorrang bleibt: manuell schlägt Stempel.** Ein gepinnter MA (`presenceOverride != null`) wird vom Sync gar nicht angefasst – sein Stempel ändert weder `present` noch seine Zuweisungen, solange der Pin steht. Zurück auf Auto (`presenceOverride = null`) rechnet die Route sofort neu; ergibt sich dabei ein Wechsel, unterbricht/erinnert der Sync selbst (deshalb dort kein zweiter Aufruf).

**Warum das zwingend ist:** Netto-Arbeitszeit = `finishedAt − startedAt − pausedMs`. Ohne die Unterbrechung beim Ausstempeln lief der Schritt weiter und die **ganze Nacht** wurde als Arbeitszeit gebucht. `pausedAt` ist dabei der Beginn des offenen Intervalls – erst `closePause` (Fortsetzen/Abschließen) rechnet es auf `pausedMs`. **`switchCount` wird bewusst NICHT erhöht:** Feierabend ist kein Arbeitsschritt-Wechsel (gleiche Regel wie beim Scheduler).

Grenzen (bewusst): der Sync läuft im **Minutentakt**, die Unterbrechung setzt also bis zu **60 s** nach dem echten Stempel ein – die exakte Stempelzeit rückwirkend zu übernehmen bräuchte einen weiteren Crewmeister-Abruf. Fällt Crewmeister aus, passiert nichts (best effort); dann greift die Uhrzeit-Regel des Schedulers. Der Nachlauf je MA läuft in `try/catch` – ein Fehler (z. B. Push) darf den Sync der übrigen MA nicht abbrechen. Getestet in `services/presence.test.ts`.

### Pflichtnotiz beim Abschluss (`Step.noteRequired`)

Ein Schritt kann eine **Pflichtnotiz** verlangen (Menge, Chargennummer, …). Konfiguriert wird sie je Schritt im Aufgaben-Tab: `noteRequired` (an/aus), `noteFormat` (**Freitext** oder **Zahl**), `noteLabel` (Beschriftung, z. B. „Anzahl Paletten").

**Die Angabe ist Teil der Abschluss-Aktion, nicht eine vorher geschriebene Notiz.** `POST /assignments/:id/complete` nimmt dafür einen Body `{ note?: string }`; ohne gültigen Wert antwortet die Route mit **400**. Bewusst nicht über „es muss irgendeine Notiz am Schritt hängen" gelöst — eine alte Freitext-Notiz würde die Pflicht sonst miterfüllen, und die gefragte Zahl steht ohnehin erst am Ende fest.

| Entscheidung | Warum |
|---|---|
| Guard im **Backend**, nicht nur in der Oberfläche | Dashboard-Rollen dürfen laut `assertMayActOnAssignment` fremde Zuweisungen abschließen – die UI ist nur einer von zwei Wegen |
| Notiz im **selben `$transaction`-Block** wie `state: "DONE"` | sonst könnte der Schritt fertig werden und die Angabe verloren gehen |
| **Eine** Angabe je Team-Schritt | der Abschließende gibt sie für alle ab; die Menge ist Eigenschaft des Schritts, nicht der Person. Gleiches beim Übernahme-Abschluss (`maxWorkers === 1`) |
| Deutsches **Komma** erlaubt (`42,5`) | sonst ist die Zahl auf der Handy-Zifferntastatur nicht eingebbar. `validateCompletionNote` (Backend) und `isCompletionNoteValid` (beide Clients) müssen dasselbe akzeptieren |
| `label` wird **im Eintrag mitgespeichert** | `Step.noteLabel` kann sich später ändern; der Snapshot soll zeigen, wonach damals gefragt wurde |

Der Wert landet als Notiz-Eintrag mit **`kind: "COMPLETION"`** (bei `NUMBER` zusätzlich `value` als Zahl) im Verlauf, wird von `finalizeTask` in den TaskRun eingefroren und ist damit ohne Zusatzarbeit im Tagesjournal sichtbar – dort **fett mit Beschriftung** („Anzahl Paletten: 42"), damit die Messung zwischen Freitext-Notizen nicht untergeht. `kind`/`value`/`label` sind **optional**, damit alle vor der Einführung geschriebenen Einträge die `asNoteArray`-Schranke weiter passieren.

Der **Kopier-Pfad** (`POST /tasks/:id/copy`) übernimmt die drei Felder – sonst verlöre eine Kopie die Regel still. Getestet in `services/notes.test.ts` (19 Tests zu Prüfung und Eintrag).

**Grenze (bewusst):** Der Zahlwert wird **nicht** in `WorkLog` geschrieben – eine Auswertung „Ø Menge je Schritt" gibt es damit nicht. Der Wert steckt im Snapshot und wäre nachträglich backfillbar.

### Erinnerungen (`Reminder`) – wiederkehrende Dinge mit Entscheidung

Dinge, an die jemand in regelmäßigen Abständen denken muss (Wartung, Prüfung, Bestellung). Angelegt werden sie im **Erinnerungen-Tab**, entschieden wird über sie im **Banner ganz oben im Dashboard**, sobald sie fällig sind.

**Tagesgenau, nicht uhrzeitgenau.** Fällig ist alles mit `dueDate <= heute`; das Banner fragt das beim Laden ab. Daraus folgt zweierlei, beides Absicht:

- **Es braucht keinen Scheduler.** Die uhrzeitbasierten Regeln im `scheduler.ts` laufen über `isExactMinute()` – trifft der Server diese Minute nicht (Neustart, Update), fällt die Regel ersatzlos aus. Für eine Wartungserinnerung wäre das der falsche Handel. Über `dueDate` kann nichts verpasst werden: was fällig war, bleibt fällig.
- **Nichts verschwindet von selbst.** Überfälliges steht weiter im Banner (rot abgesetzt, mit „seit N Tagen“), bis jemand entscheidet.

**Vier Entscheidungen**, jede erzeugt ein `ReminderEvent` und landet damit namentlich mit Uhrzeit im Tagesjournal:

| Knopf | Wirkung | Nächster Termin |
|---|---|---|
| **Erledigt** | erledigt, fertig | nach Takt |
| **Verschieben** | 1–7 Tage (Menü) | genau in N Tagen; **der Takt bleibt unberührt** |
| **Pool** | wird zum Arbeitsschritt, den ein qualifizierter MA übernimmt | nach Takt |
| **Hinfällig** | diesmal nicht nötig | nach Takt |

| Entscheidung | Warum so |
|---|---|
| Takt zählt ab dem **Entscheidungstag**, nicht ab der alten Fälligkeit | Wer eine tägliche Erinnerung eine Woche liegen lässt und dann abhakt, soll sie morgen wiedersehen – nicht sechsmal rückwirkend |
| Verschieben ist auf **7 Tage** gedeckelt (`MAX_POSTPONE_DAYS`) | Wer länger schieben will, soll den Termin in der Erinnerung ändern, statt sie Woche für Woche vor sich herzuschieben |
| „Hinfällig“ streicht nur **diesen** Termin | Die Erinnerung selbst bleibt bestehen und kommt zum nächsten Takt wieder; ganz loswerden geht im Tab (Pausieren/Löschen) |
| Einmalige Erinnerung (`NONE`) wird nach der Entscheidung **inaktiv** | Sie hat keinen Folgetermin – statt sie zu löschen, rutscht sie in „Abgeschlossen“ und bleibt nachlesbar |
| Monatlich am 31. wird auf den **Monatsletzten gekappt** | Naive Datumsarithmetik landet im Februar sonst im März |
| Wöchentlich am heutigen Wochentag springt **eine ganze Woche** weiter | Sonst stünde die Erinnerung direkt nach dem Abhaken wieder im Banner |

**„Pool“ erzeugt eine echte Aufgabe.** Eine Erinnerung mit Fähigkeit wird zu einer Aufgabe mit **einem** Schritt (Fähigkeit = die der Erinnerung) – damit greifen Pool-Filter, Fähigkeits-Prüfung, Zeitbuchung, Notizen und Tagesjournal unverändert, ohne dass Erinnerungen einen eigenen Arbeits-Weg brauchen. Die Aufgabe entsteht beim **ersten** „Pool“ und wird danach **wiederverwendet** (`Reminder.taskId`, beim erneuten Auslösen wie „Starten“ zurückgesetzt) – sonst läge nach einem Jahr wöchentlicher Wartung 52-mal dieselbe Aufgabe im Aufgaben-Tab. **Ohne Fähigkeit ist „Pool“ gesperrt** (Knopf sichtbar, aber inaktiv; Route antwortet mit 400): niemand wäre qualifiziert, den Schritt zu übernehmen.

**Im Tagesjournal** stehen die Entscheidungen als eigene Zeilen unter den Durchläufen (`components/ReminderJournal.tsx`, Dashboard **und** Historie-Tab) – mit Entscheidungs-Pille, Titel, Name und Uhrzeit, beim Verschieben zusätzlich dem Ziel. Sie kommen aus `GET /stats/journal/reminders`, **nicht** aus `/journal`: die TaskRun-DTOs bleiben unangetastet, und eine abgehakte Erinnerung wird nicht mit geleisteter Arbeit verwechselt. `GET /journal/days` zählt Tage mit Entscheidungen mit (ein Tag kann **nur** aus Erinnerungen bestehen), `DELETE /journal/:date` und die Journal-Aufbewahrung (`purgeOldJournals`) räumen sie mit weg.

Getestet in `services/reminders.test.ts` (16 Tests, Schwerpunkt Monatsende, Wochentags-Sprung und „Takt ab Entscheidung“).

### Unterbrechen / Wechseln
> Begriff: in der **Oberfläche** heißt das Pausieren **„Unterbrechung"** (es ist ein Arbeitsschritt-Wechsel, keine echte Pause). Die **internen** Bezeichner bleiben `PAUSED`/`pausedAt`/`pausedMs`/`closePause` (keine DB-Umbenennung).

Login auf Schritt B während aktiv auf A → A automatisch unterbrochen (`SWITCH`). Wird der Platz durch Ersatz aufgefüllt → ursprüngliche Zuweisung aufgelöst. Jede Unterbrechung setzt `Assignment.pausedAt`; beim Fortsetzen/Abschließen rechnet `closePause` das Intervall auf `pausedMs` drauf (kumulierte Unterbrechungszeit für die Netto-Arbeitszeit-Auswertung). **Erinnerung:** schließt ein MA einen weiteren Schritt ab und hat noch unterbrochene Schritte offen, feuert `remindOwnInterruptedSteps` (`WORK_REMINDER` + Best-Effort-Push); die **PWA** zeigt dem MA dazu ein schließbares Banner (`components/Notices.tsx`), das Manager-Dashboard eins für den Manager. **Nicht** zeitbasiert.

### Push (nur bei „hoch") — ✅ Backend + PWA-Empfang (M4) fertig
Verhalten (in `services/push.ts` umgesetzt):
1. Aufgabe wird „hoch" **oder** eine bereits hochpriore Aufgabe wird in den Pool gestellt („Starten", `poolEnabled` false→true) → `tasks.ts` ruft `notifyHighPriorityTask()` → Push für alle offenen (freigegebenen) Schritte.
2. Vorgänger-Abschluss gibt Schritt frei → `assignments.ts` publiziert `STEP_UNLOCKED` und ruft bei hoher Priorität `notifyReleasedStep()`.

**Beide Regeln setzen voraus, dass die Aufgabe im Pool ist** (`poolEnabled`). Bei Regel 1
wird das seit dem 07.09.2026 ausdrücklich geprüft: `deriveStepStatus` kennt `poolEnabled`
**nicht**, ein Schritt einer nicht gestarteten Aufgabe gilt dort als `OPEN`. Vorher hätte
das Hochstufen einer ungestarteten Aufgabe auf „hoch" einen Push über Arbeit ausgelöst,
die in der PWA gar nicht auftaucht (`GET /pool` filtert auf `poolEnabled`). Das
Dashboard-Ereignis `TASK_PRIORITY_HIGH` bleibt ungefiltert – es ist ein
Invalidierungs-Signal, keine Störung.

> **Ton kann die Anwendung nicht bestimmen.** Web-Push landet auf Android in einem
> **Benachrichtigungs-Kanal von Chrome**; Wichtigkeit und Ton stellt der Nutzer in den
> Android-Einstellungen ein (Einstellungen → Apps → Chrome → Benachrichtigungen → Kanal
> der Adresse). Kein Feld der Push-API ändert daran etwas. Beeinflussbar ist allein die
> **Vibration** (`vibrate` in `showNotification`, in `pwa/src/sw.ts` gesetzt) – im Lager
> ohnehin das verlässlichere Signal. „Bitte nicht stören"/Bedtime unterdrückt **beides**.

**Empfänger:** qualifizierte MA, die **nicht bereits auf einer HIGH-Aufgabe** eingeloggt sind – also freie **und** an niedriger-priorer Arbeit (damit sie zur wichtigen Aufgabe umschwenken können); wer schon auf einer hohen Aufgabe ist, wird nicht gestört. Push ist „best effort" (fehlende VAPID-Keys/Sendefehler scheitern nie einen Request; 404/410-Abos werden aufgeräumt). Die PWA empfängt via Service Worker (M4); die App-interne Anzeige (Banner) bleibt zusätzlich verlässlich.

### Eskalation
Offener Schritt einer hoch-priorisierten Aufgabe länger als `escalationMins` unbearbeitet → Alert an Manager + Push an qualifizierte MA (gleiche Empfänger-Regel wie oben: auch MA auf niedriger-priorer Arbeit, nicht die auf HIGH). Nur in Arbeitszeit.

**Der Alarm wiederholt sich jede Minute** – absichtlich: er soll drücken, bis jemand übernimmt. Er endet von selbst, sobald am Schritt eine Zuweisung in `ACTIVE` **oder** `PAUSED` hängt (`hasActive`-Guard); es braucht also keine Quittierung. **Feinheit:** der Guard wirkt **je Schritt**, nicht je Aufgabe – hat eine HIGH-Aufgabe mehrere freigegebene Schritte, eskalieren die noch unbesetzten weiter, auch wenn an einem anderen schon gearbeitet wird. Das ist gewollt (die liegen ja wirklich noch da).

**Pause:** Im Fenster `Settings.breakStart`–`breakEnd` (Default **12:00–12:30**, im Einstellungen-Tab pflegbar, gleiche Zeiten = keine Pause) feuert die Eskalation **nicht** – dort ist niemand da, der übernehmen könnte, und der Minutentakt wäre reine Störung. Nach der Pause läuft sie von selbst weiter, sofern der Schritt dann noch liegt: **es geht nichts verloren, es wird nur später gemeldet.** Bewusst **nur** die Eskalation – die einmaligen Pushs (neue Hoch-Prio-Aufgabe, neu freigegebener Schritt) sind kein Spam und kommen auch in der Pause durch. Grenzen-Konvention wie bei den Arbeitszeiten: Beginn **einschließlich**, Ende **ausschließlich** (um 12:30 eskaliert es wieder).

---

## Echtzeit-Events (Kanal `lagerhub`)

`SKILL_CREATED`, `EMPLOYEE_CREATED`, `EMPLOYEE_UPDATED`, `EMPLOYEE_DEVICE_RESET`, `EMPLOYEE_DELETED`,
`TASK_CREATED`, `TASK_UPDATED`, `TASK_PRIORITY_HIGH`, `TASK_COMPLETED`, `TASK_RESTARTED`, `TASK_DELETED`,
`TASKS_REORDERED`, `STEP_CREATED`, `STEP_UPDATED`, `STEP_DELETED`, `STEP_TIMER_STARTED`, `STEP_UNLOCKED`, `STEPS_REORDERED`, `STEP_NOTE_UPDATED`,
`ASSIGNMENT_CHANGED`, `ASSIGNMENT_OFFERED`, `ASSIGNMENT_REJECTED`, `ASSIGNMENT_WITHDRAWN`, `TEAM_UNDERSTAFFED`,
`JOURNAL_UPDATED`, `JOURNAL_DELETED`, `REMINDER_UPDATED`,
`END_OF_DAY`, `WORK_REMINDER`, `ESCALATION`, `SETTINGS_UPDATED`

> `JOURNAL_DELETED` hat **zwei** Auslöser: das manuelle Löschen eines Tages (`DELETE /stats/journal/:date`, mit `date`) und den automatischen Aufräumlauf (`purgeOldJournals`, mit `reason: "retention"` + `days`). Für die Clients ist der Unterschied bisher egal – beide invalidieren den `stats`-Prefix; das Feld ist für die Nachvollziehbarkeit im Log da.

---

## Offene Punkte

- [x] **DB-Migration `Step.startedAt`** angewandt (Migration `20260606195704_init`; DB war leer → kein Reset)
- [x] **`DIRECT_URL` gefixt** auf Session-Mode-Pooler (Port 5432, IPv4); echte Direktverbindung ist IPv6-only/unerreichbar
- [x] **firebase-admin entfernt**, **`web-push` + `@types/web-push` installiert**
- [x] **`.env.example` aktualisiert** (Firebase raus, VAPID rein, `DIRECT_URL` = Session-Pooler)
- [x] **Web-Push-Logik umgesetzt:** VAPID-Keys gesetzt, `PushSubscription`-Modell + Migration `20260606202337_add_push_subscription`, `services/push.ts` + `routes/push.ts`, Push an `TASK_PRIORITY_HIGH` (Regel 1), neu freigegebene Schritte (Regel 2) und `ESCALATION` angebunden
- [x] **`STEP_UNLOCKED`-Event eingeführt** (in `assignments.ts` beim Freischalten via Vorgänger-Abschluss), löst Regel-2-Push aus
- [x] **Versionskontrolle eingerichtet:** Git-Repo besteht (Branch `master`, Commits „Initial commit: LagerHub backend + frontend", „Mitarbeiter loeschen (Soft-Delete)"); `backend/prisma/migrations/` wird mitversioniert.
- [x] **Frontend Manager-Dashboard umgesetzt:** React 19 + Vite mit vier Tabs (Aufgaben, Pool, Mitarbeiter, Statistik), TanStack-Query-Datenlayer und WebSocket-Live-Updates (`useRealtime`). Siehe Abschnitt „Frontend".
- [x] **Performance:** Query-Logging (> 5 ms) in `db.ts` zur Messung; N+1 in der Status-Ableitung beseitigt – reine `deriveStepStatus` + gebündelte Abfragen in `stepStatus.ts`, `pool.ts`, `push.ts`, `assignments.ts` (`/api/pool` ~1200 ms → ~360 ms). `connection_limit` im Transaction-Pooler erhöhbar (eigenes Gesamtlimit von pgBouncer beachten, nicht unkontrolliert hochdrehen).
- [x] **Dashboard-Performance (Frontend):** Refetch-Sturm pro Zuweisungs-Aktion entschärft – WS-Invalidierungen gebündelt (200-ms-Fenster in `useRealtime`) + redundante manuelle Invalidierung aus den Assignment-Mutationen entfernt. „Einsetzen" 5 → 2 GETs.
- [x] **Backend-Performance (Reads):** `/api/pool` von zwei Abfragen auf eine (B2). Prisma-Preview `relationJoins` + `relationLoadStrategy: "join"` auf `/api/pool` + `/api/employees` (B1) – Relationen als **ein** JOIN-SQL statt vieler SELECTs; `/api/pool` warm ~150 ms.
- [x] **`/api/tasks` Join ergänzt:** `tasks.ts` (`GET /` und `getTaskWithSteps`) nutzt jetzt `relationLoadStrategy: "join"` – Relationen als **ein** JOIN-SQL statt der früheren Multi-SELECT-Kaskade (steps → skill → assignments → predecessors). Greift auch bei allen `getTaskWithSteps`-Aufrufern (`GET /:id`, Create/Copy-Antworten). `/api/tasks` warm ~88 ms, kalt ~294 ms. Verbleibende Schwankung „manchmal langsam" rührt noch von `connection_limit=1` (gleichzeitige GETs serialisieren) und Kalt-/Idle-Start.
- [x] **Auslastungstacho:** `components/UtilizationGauge.tsx` im Dashboard (Personalauslastung + Schritt-Besetzung + Engpässe), rein aus `pool`/`employees` abgeleitet.
- [x] **Dashboard-Kompaktansicht:** je Bereich max. 3 Einträge mit fester Reservehöhe + „Alle anzeigen"-Umschalter; Karten eingeklappt.
- [x] **Anwesenheits-Sperre:** abwesende MA können nicht eingesetzt/angeboten werden (Backend-Guard + Frontend-Filter).
- [x] **Schritt-Notizen + Tagesjournal-Historie:** Notiz-Verlauf je Schritt (`Step.notes`, append-only; Migration `add_step_notes`), Anhängen via `POST /steps/:id/notes` (Manager/MA). In Snapshot eingefroren (`finalizeTask`), beim Neustart/Abschluss geleert. Statistik-Tab zeigt alle Tagesjournale (`/journal/days` + `?date=`; **inzwischen in den eigenen Historie-Tab ausgezogen**), Admin kann nachtragen (`POST /journal/:runId/notes`) und ganze Tage löschen (`DELETE /journal/:date`, nur Vergangenheit). Events `STEP_NOTE_UPDATED`/`JOURNAL_UPDATED`/`JOURNAL_DELETED`. **Hinweis:** Notiz-Eingabe nutzt vorerst der Manager im Dashboard (Test-Ersatz); MA-Eingabe kommt mit der PWA (Endpoint via `employeeId` bereits vorbereitet).
- [x] **Historie/Auswertung (WorkLog + Diagramme):** Denormalisierte `WorkLog`-Tabelle (Migrationen `add_worklog` + `worklog_index_by_finishedat`), Schreiben in `finalizeTask`, idempotenter Backfill (`npm run backfill:worklog`). Endpoints `/stats/employee-history` + `/stats/throughput` (Zeitraum, Default 7 Tage). Frontend: `components/AnalyticsSection.tsx` mit **Recharts** (aktive Zeit/Schritte je MA, Durchsatz pro Tag, Ø Dauer je Aufgabentyp) im Statistik-Tab. **Grenzen:** nur abgeschlossene Läufe; Läufe vor der pausedMs-Migration haben `pausedMs=0` (Netto=Brutto); keine „wer-hat-abgeschlossen"-Zuordnung; echte %-Auslastung (Anwesenheit) wird nicht geloggt.
- [x] **Kumulierte Pausenzeit + MA-Zeiten-Auswertung:** `Assignment.pausedMs` (Migration `add_assignment_paused_ms`) + Helper `closePause` (addiert offene Intervalle bei Resume/Complete/Snapshot). Netto-Arbeitszeit = `finishedAt − startedAt − pausedMs`. `/stats/employee-load` liefert Netto + `pausedMinutes`; Journal liefert pro Schritt `workers[]` (MA mit Einzelzeiten). Tagesjournal als **Baum** (`components/JournalRunCard.tsx`, im Dashboard **und** Statistik): Aufgabe → Schritte → MA-Zeiten + einklappbare Notizen.
- [x] **Wechsel-ANZAHL statt -Dauer:** MA-Detail-Auswertung zeigt „Wechsel (Anzahl)" (wie oft der MA den Schritt gewechselt hat), nicht mehr die Dauer. Neues `Assignment.switchCount` + `WorkLog.switchCount` (Migration `add_switch_count`), +1 bei jeder SWITCH-Unterbrechung (Auto-Wechsel + manuelles „Unterbrechen"; **nicht** Feierabend), in `finalizeTask` eingefroren. `/stats/employee-detail` liefert `switchCount`/`avgSwitchCount`. Tagesjournal zeigt die Unterbrechungs-Dauer nicht mehr. **Grenze:** nicht rückwirkend – alte Läufe = 0.
- [x] **Cleanup:** `ts-node-dev` entfernt (dev läuft über `tsx watch`), ungenutzte Imports/Parameter raus, Firebase-Fragment aus `.env` entfernt.
- [x] **Team-Schritt WAITING:** besetzter Team-Schritt unter `min` läuft noch nicht (Status `WAITING`, Timer/„In Bearbeitung" erst ab Mindestbesetzung); im Dashboard ausgewiesen.
- [x] **Einsetzen-Perf + Voll-Sperre:** `activateOnStep` prüft Anwesenheit+Fähigkeit in einer Abfrage, `afterAssignmentChange` leitet alles aus **einem** `step.findMany` ab (~3 Roundtrips weniger pro Einsetzen). Dashboard sperrt volle Schritte (`aktive MA ≥ maxWorkers`) mit Hinweis statt 409.
- [x] **Übernahme-Abschluss + Unterbrechung-Begriff + Erinnerung:** Einzel-Slot-Schritt (`max 1`) schließt bei Übernahme die unterbrochene Vorgänger-Zuweisung mit ab. UI-Begriff „Pause" → **„Unterbrechung"** (intern `PAUSED` unverändert). Erinnerung an eigene unterbrochene Schritte beim Abschluss eines weiteren Schritts (`WORK_REMINDER` + Push) + Dashboard-Banner (`alert--info`).
- [x] **Rollen + Admin-Zugang:** Rolle ADMIN = Dashboard-Vollansicht über **geheime PIN** (`ADMIN_PINS` in `.env`, `adminPins.ts`, `/pin-login`) – kein MA-Datensatz, keine Migration. Tab-Matrix: MANAGER ohne Statistik, OFFICE zusätzlich Aufgaben (siehe „Rollen & Dashboard-Zugang").
- [x] **Excel-Export der Statistiken:** `frontend/src/lib/statsExport.ts` (SheetJS/`xlsx`), Buttons je Statistik im Statistik-Tab; „Auswertung (Zeitraum)" packt je nach Filter alles in **eine** Mappe (mehrere Blätter), übernimmt den Zeitraum. Hinweis: `npm audit`-Warnung zu `xlsx` betrifft nur das **Parsen** fremder Dateien – hier wird nur geschrieben.
- [x] **Auth/Autorisierung (JWT + Rollen-Guards):** Zustandsloses JWT (`@fastify/jwt`, `auth.ts`, `JWT_SECRET`), beim Login (`/pin-login` + `/login`) ausgestellt; `preHandler`-Guards `authAny`/`authDashboard`/`authManager`/`authAdmin` schützen alle `/api`-Routen (401/403). Beide Frontends senden das Token (Bearer) und fangen 401 ab. **Ausbaustufe 2:** Identität aus dem Token statt Body (assignments/pool/notes/push-subscribe), WS-Auth (`/ws?token=…`, Close 1008), CORS via `CORS_ORIGIN`. Details siehe „Auth & Autorisierung". Verbleibend (Zukunft): individuelle Token-Widerrufung vor Ablauf gibt es (zustandslos) nicht – Mitigation über 12-h-Laufzeit + Secret-Wechsel.
- [x] **Sicherheits-Härtung (Prod-Vorbereitung Firmenserver):** (1) **Login-Rate-Limit** (`loginRateLimit.ts`, In-Memory, dependency-frei): `/pin-login` + `/login` max. 10 Versuche/Minute/IP → 429 + `Retry-After` (bremst PIN-Erraten; 4-stellig = 10 000 Kombis). **Muss `async` sein** – ein synchroner preHandler ohne `done()`/Promise lässt den Request hängen (wie die `auth.ts`-Guards). (2) **Besitzprüfung Zuweisungen** (`assertMayActOnAssignment` in `assignments.ts`): ein WORKER darf nur EIGENE Zuweisungen accept/reject/complete/pause/resume/leave – Dashboard-Rollen für jeden (Eingriff). (3) **PIN nur an MANAGER/ADMIN**: `GET /employees` strippt `pin` für OFFICE (kein Anmelden als fremder MA über die API). (4) **Token nicht im Log**: Fastify-`req`-Serializer maskiert `?token=…` im WS-Handshake. (5) **`trustProxy: true`** (echte Client-IP hinterm Reverse-Proxy, für den Rate-Limiter). (6) **Einheitlicher Error-Handler**: `ZodError`→400, geworfene `statusCode` bleiben, 5xx-Meldung wird nicht nach außen geleakt (nur `{ error }`, beide Frontends lesen das). (7) **`crypto.randomInt`** für Auto-PINs (statt `Math.random`). (8) **`/push/unsubscribe`** nur eigenes Abo (`employeeId` aus Token). (9) **CORS-Warnung** beim Start, wenn `NODE_ENV=production` ohne `CORS_ORIGIN`. **Cleanup:** ungenutzte `computeStepStatus` (`stepStatus.ts`) entfernt. **⚠️ Offene Nutzer-Aktion:** Alt-Admin-PINs standen als „Beispiel" im versionierten `adminPins.ts` (Git-History, Repo war nur lokal, nie gepusht) → neue `ADMIN_PINS` in `.env` vergeben; die alten gelten als kompromittiert.
- [~] **Tests:** Vitest (Node-Env) als Runner eingerichtet (`npm test` / `npm test:watch`, `vitest.config.ts`). **144 Tests, 12 Dateien:** `services/stepStatus.test.ts` (17), `services/computeTaskStatus.test.ts` (8, Aggregation über **gemocktes** `prisma.step.findMany`), `services/crewmeister.test.ts` (6), **`services/quietHours.test.ts` (12, Pause: schweigt im Fenster, Beginn einschließlich / Ende ausschließlich – 12:30 eskaliert wieder, frei konfigurierte Zeiten, und vor allem die **Nicht**-Pause: gleiche Zeiten, Ende vor Beginn, unparsbare Werte ⇒ Alarm läuft durch statt still zu verstummen)**, **`auth.test.ts` (6, Rollen-Guards via Fastify `inject`: 401/403/200 je Tier)**, **`services/presence.test.ts` (9, Anwesenheits-Wechsel gegen gemocktes Prisma: Unterbrechen beim Ausstempeln inkl. `pausedAt`/kein `switchCount`, Erinnerung beim Einstempeln, derselbe Nachlauf über den manuellen Schalter, Robustheit)**, **`services/stepAvailability.test.ts` (8, Verfügbarkeits-Uhr: stempeln nur bei OPEN, gesperrte/bearbeitete Schritte überspringen, **nie überschreiben**, Sammel-Update, Reset)** sowie die **Zugangs-/Robustheits-Trias**: **`adminPins.test.ts` (14)** – Schwerpunkt auf dem, was KEINE Admin-PIN sein darf (falsche Form, **leeres/fehlendes `ADMIN_PINS` ⇒ gar kein Admin**), Lazy-Cache dokumentiert (PIN-Wechsel wirkt erst nach Neustart); **`loginRateLimit.test.ts` (7)** – 10 Versuche/Minute/IP, 429 + `Retry-After`, **Zähler je IP getrennt** (ein Angreifer sperrt nicht das ganze Lager aus), Fenster-Ablauf, und der Vertrag „**preHandler gibt ein Promise zurück**" (synchron = jeder Login hängt); **`services/notes.test.ts` (31)** – `asNoteArray` als Schranke gegen kaputtes Prisma-Json (null/Skalar/Objekt ⇒ `[]`, einzelne defekte Einträge verwerfen statt den ganzen Verlauf), `makeNoteEntry` trimmt und ist von `asNoteArray` akzeptiert; dazu die **Pflichtnotiz** (`validateCompletionNote`/`makeCompletionNote`): deutsches Komma gilt, „42 Stück"/„zwölf"/„1,2,3" nicht, leer/nur-Leerzeichen wird abgewiesen, die Beschriftung steht in der Fehlermeldung, und der erzeugte Eintrag passiert `asNoteArray`. sowie – neu und der eigentliche Zugewinn der lokalen Datenbank – **`routes/assignments.race.test.ts` (10, echte PostgreSQL)**: gleichzeitiges Einloggen auf denselben Schritt. Fuenf Anfragen auf einen Einzel-Platz ⇒ genau **eine** 201 und vier 409; acht auf drei Plaetze ⇒ genau **drei**; die 409-Meldung nennt die tatsaechliche Belegung; ein Team-Schritt startet seinen Timer **genau einmal**, wenn die Mindestbesetzung gleichzeitig eintrifft; und als Gegenprobe laesst ein Schritt ohne Obergrenze **alle** durch (sonst waere die Suite auch dann gruen, wenn schlicht immer abgelehnt wird). **Der Test wurde gegen einen kaputten Zustand geprueft:** mit auskommentierter `FOR UPDATE`-Sperre kamen **5 von 8** in einen Dreier-Schritt und der Team-Timer startete nie – 4 der 5 Tests wurden rot, reproduzierbar. Dabei kam heraus, dass der **erste** Test ohne Aufwaermen des Verbindungspools wertlos ist: der Pool baut seine Verbindungen nacheinander auf, die Anfragen serialisieren sich von allein und der Test bleibt auch ohne Sperre gruen. Deshalb oeffnet `beforeAll` erst zehn Verbindungen parallel. **Nicht abgedeckt:** die dicken Routen (`assignments.ts`, `stats.ts`) und die Frontends (kein Runner). Nächstes Ziel unverändert: Race-Condition/`FOR UPDATE` in `assignments.ts` – **braucht eine echte Test-DB** (Zeilensperren sind nicht mockbar), also eine Infrastruktur-Entscheidung, keine reine Schreibarbeit.
- [x] **Manuelles Einsetzen (Phase 1):** Manager bietet im Dashboard einem qualifizierten, freien MA einen Schritt an (`POST /assignments/offer`, Push best-effort). Annehmen/Ablehnen via `accept`/`reject`; Ablehnung erzeugt `ASSIGNMENT_REJECTED` → Banner im Dashboard. Angebot ist unverbindlich (belegt erst bei Annahme einen Platz).
- [x] **Aufgaben-Wiederholung:** `Task.repeat` (Migration `add_task_repeat`); bei `true` hält `finalizeTask` die Aufgabe im Pool und startet sofort neu (+ `TASK_RESTARTED`), statt sie herauszunehmen. Checkbox „Wiederholen" je Aufgabe im TasksTab.
- [x] **Team-Schritt vor Beginn verlassen:** `POST /assignments/:id/leave` löscht die eigene Zuweisung (Platz frei, keine Arbeitszeit) – nur solange nicht gestartet (WAITING); atomar via `FOR UPDATE`. PWA zeigt im WAITING-Fall „Ausloggen".
- [x] **PWA M0–M3 (Mitarbeiter-App):** eigene React-19-+-Vite-6-App unter `pwa/`. PIN-Login mit Gerätebindung (PIN als Passwortfeld, `crypto.randomUUID`-Fallback fürs LAN-Handy), Arbeitsansicht (Einloggen/Abschließen/Unterbrechen/Fortsetzen/Ausloggen) mit Gruppierung „Meine Arbeit"/„Verfügbare Aufgaben", Angebote annehmen/ablehnen + MA-Notizen, WORK_REMINDER-Banner. Siehe Abschnitt „PWA (Mitarbeiter-App)".
- [x] **PWA M4 (Push-Empfang):** VitePWA **injectManifest** + eigener `pwa/src/sw.ts` (`push`/`notificationclick`), `api/push.ts` + `PushToggle` (Berechtigung → `PushManager.subscribe` → `POST /push/subscribe`, Abmelde-Cleanup). End-to-end verifiziert (Dev-Skript `npm run test:push`). **Regel-1/Eskalations-Empfänger verfeinert:** auch MA auf niedriger-priorer Arbeit; Hoch-Prio-Push feuert auch beim „Starten". Nur Secure Context (HTTPS/localhost) – seit der Dev-HTTPS-Umstellung auch über die LAN-IP, **am echten Handy verifiziert (08.09.2026)**.
- [x] **Zeiterfassung (Crewmeister) dokumentiert + Inaktiv-Zeit korrigiert:** Services `crewmeister.ts`/`presence.ts` und `/stats/employee-detail` in dieser Datei beschrieben (Abschnitt „Inaktive Zeit"). **Fix:** die Pro-Tag-Tabelle lief nur über Tage mit abgeschlossenen Schritten – ein eingestempelter Tag ohne fertigen Schritt fiel komplett raus, statt als Leerlauf-Tag zu erscheinen; jetzt Vereinigung mit den Tagen aus `getWorkingMinutes` (`stats.ts`, Tage mit 0 Stempelminuten ausgenommen). Bewusst **nicht** geändert: Pausen bleiben draußen (Netto), laufende Aufgaben zählen bis zum Abschluss als inaktiv, Mitternachts-Überlauf unbehandelt. Außerdem zeigt das Crewmeister-Dropdown im Mitarbeiter-Tab nur noch **aktive** Mitglieder – ein bereits zugeordnetes, inzwischen deaktiviertes Mitglied bleibt als Option erhalten (sonst spränge das Feld auf „Keine", obwohl die Zuordnung steht).
- [x] **Ausstempeln unterbricht die Arbeit (Zeit-Leck geschlossen):** Stempelte sich ein MA aus, während er auf einem Schritt eingeloggt war, lief die Zuweisung weiter – die **ganze Nacht** wurde als Netto-Arbeitszeit gebucht (`finishedAt − startedAt − pausedMs`), und morgens wusste niemand, wo er stehengeblieben war. Jetzt reagiert `services/presence.ts` auf den Anwesenheits-**Wechsel** (`handlePresenceTransition`): abwesend → `PAUSED`/`END_OF_DAY` + `pausedAt` (Uhr stoppt) + `afterAssignmentChange`; anwesend → `WORK_REMINDER` + Push je unterbrochenem Schritt. **Beide Auslöser** hängen daran – der Crewmeister-Stempel **und** der manuelle Anwesenheits-Schalter im Dashboard (der sonst ein Schlupfloch geblieben wäre). Dazu prüft `POST /assignments/:id/resume` jetzt die Anwesenheit (sonst wäre die Unterbrechung mit einem Klick auf „Fortsetzen" umgangen), und die uhrzeitbasierten Scheduler-Regeln gelten nur noch für MA ohne Zeiterfassung. 7 neue Tests (`services/presence.test.ts`). **Grenzen:** Minutentakt (bis 60 s Versatz), ohne Crewmeister greift weiter nur die Uhrzeit-Regel.
- [x] **Menüs in Tabellenzeilen nicht mehr abgeschnitten:** Das Kebab-Menü (⋯) im Mitarbeiter-Tab war bei den unteren Zeilen nicht bedienbar – das absolut positionierte Dropdown wurde vom `overflow: hidden` der Tabelle geklippt. Neuer gemeinsamer Hook `components/useFloatingMenu.ts` (Portal an `<body>` + `fixed`-Platzierung, Umklappen nach oben, Fensterrand-Klemmung, Reposition bei resize/scroll); genutzt von `KebabMenu` (auch im Aufgaben-Tab) und der Fähigkeiten-Mehrfachauswahl im Bearbeiten-Modus, die denselben Fehler hatte. Details siehe „Design", Punkt „Aufklappende Menüs in Tabellen".
- [x] **„Wie lange liegt der Schritt schon da?" (`Step.availableAt`):** Neue Spalte + Migration `add_step_available_at` (inkl. Backfill der zum Migrationszeitpunkt offenen Schritte), gepflegt in `services/stepAvailability.ts` an vier Stellen (Pool-Eintritt, `handleStepUnlocks`, `finalizeTask`, Pool-Austritt). Anzeige „⏱ 42 min" mit Ampel aus `escalationMins` in **beiden** Apps (`components/StepAge.tsx`, `lib/stepAge.ts`, `lib/useNow.ts`); `GET /settings` dafür von `authDashboard` auf **`authAny`** gelockert (PATCH bleibt Manager). **Nebenbei behoben:** die Eskalation rechnete bis dahin mit einem Behelf (letzter `Assignment.finishedAt`, sonst `task.startedAt`, sonst Epoch) – ein erst spät freigeschalteter Schritt galt damit **in der Sekunde seiner Freigabe** schon als überfällig; zusätzlich kippte `orderBy: finishedAt desc` (Postgres: NULLs zuerst) die Rechnung, sobald ein offenes Angebot am Schritt hing. Jetzt `step.availableAt`, `null` = keine Eskalation. 8 neue Tests (`services/stepAvailability.test.ts`, gesamt 54). Details siehe Kernregel „Verfügbarkeits-Uhr".
- [x] **Pflichtnotiz beim Schritt-Abschluss:** `Step.noteRequired`/`noteFormat`/`noteLabel` + Migration `add_step_required_note`; Guard und Anhängen in `POST /assignments/:id/complete` (eine Transaktion), Eingabe-Komponente `CompletionNotePrompt` in **beiden** Apps, Konfiguration im Aufgaben-Tab, Hervorhebung im Notiz-Verlauf/Tagesjournal. 19 neue Tests (gesamt 106). Details siehe Kernregel „Pflichtnotiz beim Abschluss".
- [x] **Aufgaben-Tab aufgeräumt:** (1) **▲▼-Buttons entfernt** – Sortieren läuft nur noch über Drag & Drop (⠿), der Nachbar-Tausch `moveStep` fiel damit weg. (2) **Schritt bearbeiten ist eine Box statt einer Tabellenzeile**: `colSpan` über die volle Breite, Felder in einem Raster `Beschriftung | Feld` (`max-content`-Spalte). Als normale Zeile mussten sich die Eingabefelder die Spaltenbreiten der **Anzeige** teilen – „Wartet auf" bekam so wenig Platz, dass jeder Schrittname umbrach. Die Checkbox-Liste dort nutzt ein Zwei-Spalten-Raster je Eintrag (`.check-list`), damit umbrechender Text **unter dem Text** fluchtet statt unter dem Kästchen. (3) **Fähigkeits-Auswahl (`SkillSelect`)** ersetzt das Textfeld mit `datalist`: aufklappende **Einfach**-Auswahl (kein Mehrfach wie bei MA – ein Schritt trägt genau eine Fähigkeit) über denselben `useFloatingMenu`-Hook; Suchfeld im Menü, und was es nicht findet, bietet es als „Neu anlegen" an – **der Skill-Upsert-Weg für neue Fähigkeiten muss erhalten bleiben**. Nur die Liste scrollt, damit „Neu anlegen" bei vielen Fähigkeiten erreichbar bleibt.
- [x] **Branding/Farbwelt (inter-drive.de):** gemeinsame Navy-(`#212C3D`)-+-Gold-(`#EEC643`)-Palette als CSS-Variablen in Dashboard **und** PWA (Navy = Kopf/Topbar/Primär-Buttons/aktiver Text, Gold = Akzentlinie/aktiver Tab/PWA-Angebot). Semantik-Farben unverändert. Details siehe Abschnitt „Design / Farbwelt (Branding)".
- [x] **Einstellungen-Tab (ADMIN) – Betriebsparameter endlich bedienbar:** `escalationMins`, `workStart`/`workEnd` waren nirgends in der Oberfläche änderbar (nur per direktem `PATCH /api/settings`), die Journal-Aufbewahrung saß im Historie-Tab. Jetzt ein eigener **ADMIN-exklusiver** Tab `tabs/SettingsTab.tsx` mit vier Karten (Arbeitszeiten, Eskalation, **Pause**, Automatische Löschung). Dazu: neue Felder `Settings.breakStart`/`breakEnd` + Migration `add_break_window`, `quietHours.ts` von der Code-Konstante auf übergebene Werte umgestellt (weiter pur, keine zusätzliche DB-Abfrage – der Scheduler hat die Settings schon), `PATCH /settings` von `authManager` auf **`authAdmin`** verschärft (sonst wäre der ADMIN-Tab reine Oberflächen-Kosmetik), echte Uhrzeit-Validierung statt `\d{2}:\d{2}` und Ordnungsprüfung **gegen den Stand nach dem Merge**. 5 neue Tests (gesamt 118), Rollen-Absicherung end-to-end geprüft (MANAGER → 403, ohne Token → 401). **Nebenbei behoben:** der „Tag löschen"-Knopf im Historie-Tab war für OFFICE sichtbar, obwohl die Route `authManager` ist – jetzt an `isManager` gebunden. **Grenze:** weiterhin **ein** Pausenfenster; ein zweites (Frühstück) bräuchte ein Listenfeld statt zweier Spalten.
- [x] **Eskalation schweigt in der Mittagspause:** Der Überfällig-Alarm feuert bewusst **jede Minute** erneut (er soll drücken, bis jemand übernimmt) – in der Pause war das reine Störung, weil niemand da ist, der übernehmen könnte. Neues abhängigkeitsfreies Modul `services/quietHours.ts` mit `QUIET_PERIODS` (**12:00–12:30**, hart im Code) + `isWithinQuietPeriod(now?)`; der Scheduler steigt nach dem Arbeitszeit-Check aus. **Nur** die Eskalation ist betroffen, die einmaligen Pushs (Regel 1/2) kommen weiter durch. 7 neue Tests (gesamt 113). **Nicht geändert:** der Abbruch bei Übernahme funktionierte bereits – der `hasActive`-Guard überspringt jeden Schritt mit ACTIVE/PAUSED-Zuweisung. Details siehe Kernregel „Eskalation".
- [x] **Historie als eigener Tab + automatische Journal-Aufbewahrung** (in dieser Doku bis 30.08.2026 nicht beschrieben, im Code seit Migration `add_journal_retention`): Die Tagesjournale sind aus dem Statistik-Tab in `tabs/HistoryTab.tsx` ausgezogen, damit **OFFICE** die Historie sehen kann, ohne die ADMIN-Statistik zu bekommen (Default: letzte 5 Tage, ältere über Von/Bis mit „Suchen"). Dazu `Settings.journalRetentionDays` (0 = deaktiviert), `services/journalRetention.ts` (`purgeOldJournals`, Cascade über `WorkLog`), Auslöser Scheduler **03:00** + Serverstart + sofort bei `PATCH /settings`, Sammel-`JOURNAL_DELETED` mit `reason: "retention"`. Bedienung in der Karte „Automatische Löschung" (MANAGER/ADMIN). Details siehe Kernregel „Aufbewahrung der Tagesjournale". **Nicht abgedeckt:** kein Test (der Stichtag ist reine Datumsarithmetik, aber genau dort sitzt der typische Off-by-one) – Kandidat für die nächste Test-Runde.

- [x] **Redis entfernt – Ereignis-Verteilung läuft prozessintern (`events.ts`):** Vorbereitung für den Betrieb auf einem **Windows Server**, für den es kein offizielles Redis gibt. Der Redis-kompatible Ersatz (Memurai) wäre ein zusätzlicher Dienst samt Lizenzfrage gewesen – für eine Aufgabe, die Redis hier ohnehin nur als **Verteiler** erfüllt hat (Daten lagen nie dort, PostgreSQL ist und bleibt Source of Truth). Neues Modul `src/events.ts` mit unveränderter Signatur `publish(channel, payload)`, sodass **alle ~35 Aufrufstellen gleich blieben**; `server.ts` hört über `subscribe()` statt über `redisSub.on("message")`. Zwei Details, die dabei bewusst gesetzt sind: Zustellung über **`setImmediate`** (wie zuvor der Netzweg – ein langsamer oder fehlerhafter Empfänger kann den Request nicht aufhalten), und **try/catch je Empfänger**, weil `emit` synchron aufruft und eine Ausnahme sonst als unbehandelter Fehler den Prozess beendet hätte. `ioredis` und `REDIS_URL` sind raus. **Verifiziert end-to-end** (nicht nur über die Tests, die Prisma mocken und den WS-Pfad nie berühren): Anmeldung → echter WebSocket → `PATCH /settings` → `SETTINGS_UPDATED` kam beim Client an. **Grenze, die das setzt:** siehe Architektur-Grundsatz – genau **ein** Backend-Prozess; für zwei bräuchte es wieder einen Broker.

- [x] **Pool-Austritt ließ Mitarbeiter auf dem Schritt hängen (verwaiste Zuweisung):** Wurde eine Aufgabe über „Aus Pool entfernen" (`PATCH /tasks/:id`, `poolEnabled=false`) zurückgezogen, während ein MA auf einem noch nicht gestarteten **Team-Schritt** (WAITING) eingeloggt war, blieb dessen Zuweisung bestehen – für ihn aber **unsichtbar**, weil `GET /pool` auf `poolEnabled: true` filtert. Er konnte den Schritt weder abschließen (Team-Schritt ohne `startedAt` → 409) noch verlassen (`/leave` braucht die Zeile in der Oberfläche) und zählte dauerhaft als „im Einsatz". **Zwei Regeln, die jetzt gelten:** (1) Der Pool-Austritt ist **nur erlaubt, solange kein Schritt begonnen wurde** (`task.startedAt === null`), sonst **409** – das Dashboard zeigte den Knopf über `removable` ohnehin nur dann, die API setzt es jetzt durch und schützt gebuchte Arbeitszeit. (2) Beim Austritt werden die Zuweisungen des laufenden Versuchs in **derselben Transaktion** gelöscht (Helper `withdrawFromPool` in `tasks.ts`) – **Löschen statt PAUSED** ist hier korrekt und exakt die `leave`-Semantik: es lief kein Timer, es ist keine Arbeitszeit gebucht. Offene Angebote (OFFERED) gehen mit weg. Zusätzlich wird **`ASSIGNMENT_CHANGED`** publiziert, weil `TASK_UPDATED` allein die Mitarbeiter-Liste (Live-Status „arbeitet gerade an") nicht invalidiert. (3) Das Dashboard **fragt vorher nach**, wenn MA auf der Aufgabe eingeloggt sind (`confirmingRemove` in `PoolTab.tsx`): Inline-Leiste unter dem Kartenkopf mit den betroffenen Namen – gleiches Muster wie die Start-Bestätigung im Aufgaben-Tab, bewusst kein blockierendes `confirm()`. Sind keine MA eingeloggt, wird ohne Rückfrage entfernt (kein Klick mehr als nötig); offene Angebote lösen keine Rückfrage aus, weil sie unverbindlich sind. (4) Der ausgeloggte MA **erfährt es auch**: je betroffener Zuweisung ein **`ASSIGNMENT_WITHDRAWN`** (Muster wie `WORK_REMINDER`: die PWA filtert auf die eigene `employeeId`) → amber-Banner in `components/Notices.tsx`, dazu **ein** Best-Effort-Push je MA (nicht je Schritt), falls die App gerade zu ist. Ohne das verschwände der Schritt kommentarlos aus seiner Liste. Gemeldet werden nur ACTIVE/PAUSED – ein verfallenes Angebot ist keine Nachricht wert. **Altlasten:** `npm run fix:orphans` (Default = Testlauf, `-- --apply` löscht) findet Zuweisungen an Aufgaben außerhalb des Pools und räumt **nur** die verlustfreien Fälle ab (Aufgaben- **und** Schritt-Timer null); alles mit gelaufener Zeit wird gemeldet, nie angefasst. **Präzedenz:** `DELETE /tasks/:id` machte es schon richtig (409 bei aktiver Arbeit + `deleteMany` der Zuweisungen) – der Pool-Austritt war die Lücke daneben. **Grenze:** Ein winziges Rennen bleibt – loggt sich ein MA in genau dem Moment zwischen Guard und Transaktion ein, ist seine Zuweisung wieder verwaist; `activateOnStep` sperrt die **Step**-Zeile, nicht die Aufgabe. Dafür gibt es das Aufräum-Skript.

- [x] **Erinnerungs-Tab (wiederkehrende Erinnerungen mit Entscheidung):** Neue Modelle `Reminder` + `ReminderEvent` (Migration `add_reminders`), reine Terminrechnung in `services/reminders.ts` (16 Tests), Route `routes/reminders.ts`, Tab `tabs/RemindersTab.tsx` (Anlegen/Pflegen, MANAGER/ADMIN), Banner `components/ReminderBanner.tsx` ganz oben im Dashboard mit den vier Entscheidungen, Journal-Anzeige `components/ReminderJournal.tsx` (Dashboard + Historie), Anzeige-Hilfen in `lib/reminderFormat.ts`. **Bewusst ohne Scheduler** (tagesgenau statt uhrzeitgenau – siehe Kernregel „Erinnerungen“). End-to-end verifiziert: anlegen → Banner → verschieben → Journal-Eintrag (namentlich, mit Ziel) → Pool-Aufgabe entsteht und ist über `/pool` sichtbar; Testdaten anschließend restlos entfernt. **Grenzen (bewusst):** ein Pausenfenster-Äquivalent gibt es nicht – eine Erinnerung, die auf einen Sonntag fällt, steht am Sonntag im Banner (Wochentags-Takt umgeht das); Feiertage kennt das System nicht; die Erinnerung selbst trägt keine Uhrzeit.

- [x] **Lokales HTTPS (Vorbereitung Produktivbetrieb):** Beide Dev-Server laufen über HTTPS, das Backend bleibt HTTP auf `localhost` – dasselbe Bild wie später hinter IIS. Neu: `dev-certs.ps1` (eigene Mini-CA + Server-Zertifikat mit automatisch gesammelten SANs inkl. LAN-IP, Eintrag per `certutil`), `server.https` in beiden `vite.config.ts` (fällt ohne Zertifikat auf http zurück und warnt), `start.ps1` erzeugt das Zertifikat bei Bedarf selbst und zeigt die Handy-Adresse an, `certs/` gitignored. **Nebenbei geschlossen:** das Backend lauschte auf `0.0.0.0:3000` – die Klartext-API war damit samt Bearer-Token für jeden im Netz erreichbar und das HTTPS der Apps umgehbar; jetzt `HOST`-Default `"localhost"` (per `.env` zu öffnen). **Verifiziert** (nicht über die Tests – die mocken Prisma und berühren den WS-Pfad nie): `https` auf beiden Apps und über die LAN-IP, API durch beide Proxys, und die volle Kette Login → **`wss://…/ws?token=…`** → `PATCH /settings` mit den Ist-Werten → `SETTINGS_UPDATED` kommt an, sowohl über `localhost` als auch über die LAN-Adresse. Ebenfalls geprüft: `http://<LAN-IP>:3000` ist nicht mehr erreichbar. **Am echten Handy nachgeholt (08.09.2026):** Dev-CA installiert, Service Worker registriert sich, `PushManager.subscribe` läuft über `https://<LAN-IP>:5174`, Push kommt an. Damit ist die Kette bis auf das Prod-Zertifikat vollständig geprüft. Details siehe Abschnitt „Lokales HTTPS (Entwicklung)".

- [x] **Produktions-Auslieferung vorbereitet (IIS):** `web.config` für beide Apps in `public/` (kommt per `vite build` ins `dist/`, kann also nicht vergessen werden): ARR-Weiterleitung von `/api` + `/ws`, SPA-Fallback, `webSocket enabled`, fehlende MIME-Typen, `DisableCache` für `index.html` und – in der PWA – für `sw.js`/`registerSW.js`/`manifest.webmanifest`, dazu HSTS und drei Sicherheits-Header. `backend/.env.production.example` als Vorlage (`NODE_ENV`, `TZ=Europe/Berlin`, `HOST=localhost`, DB ohne Pooler-Parameter, neues `JWT_SECRET`/`ADMIN_PINS`, `CORS_ORIGIN`); `.gitignore` musste dafür eine Ausnahme bekommen (`.env.*` hätte die Vorlage verschluckt). **Zwei Fehler gefunden, die erst hinter dem Proxy zuschlagen und deshalb mit behoben sind:** (1) der WebSocket hatte **kein Lebenszeichen** – bei ARRs 30-s-Leerlauf-Zeitlimit wäre die Verbindung dauernd gefallen; jetzt Ping alle 20 s plus Aufräumen toter Sockets (`HEARTBEAT_MS` in `server.ts`, verifiziert: 3 Pings in 50 s, Verbindung stand). (2) **`onopen` lud nichts nach** – jeder Abriss war ein Loch, in dem Ereignisse verlorengingen, ohne dass die Oberfläche es merkte; beide `useRealtime.ts` invalidieren jetzt beim **Wieder**verbinden. Offen für den Einrichtungstag: `X-Forwarded-For` prüfen (daran hängt der Login-Rate-Limiter, siehe Abschnitt) und WebSocket durch ARR am echten IIS. Details siehe Abschnitt „Auslieferung in Produktion (IIS)".

- [x] **PostgreSQL lokal – Supabase abgelöst:** PostgreSQL **17.11** als Windows-Dienst (`postgresql-x64-17`, nur `localhost`), Rolle + Datenbank `lagerhub`, Schema über `prisma migrate deploy` (alle 20 Migrationen sauber durch, 14 Tabellen). **Bewusst ohne Datenübernahme** – der alte Bestand (6 MA, 8 Aufgaben, 51 Durchläufe, 210 WorkLog-Zeilen, Historie 17.06.–03.09.) war Testmaterial; das Supabase-Projekt bleibt unangetastet, die alten Verbindungszeichenfolgen stehen auskommentiert in der `.env`. **Wirkung:** `pgbouncer=true` und **`connection_limit=1`** entfallen – damit ist die Serialisierung gleichzeitiger Anfragen weg (`/api/pool` ~150 ms → ~11 ms, allerdings bei leerer DB, also eine Untergrenze). **Nebengewinn:** erste echte Test-DB des Projekts → der Race-Condition-Test auf `assignments.ts` ist jetzt schreibbar. **Zwei Fallstricke, beide getroffen:** (1) `Set-Content -Encoding utf8` in PowerShell 5.1 schreibt **mit BOM** und macht aus UTF-8-Umlauten Mojibake, weil `Get-Content` die Datei ohne BOM als ANSI liest – die `.env`-Kommentare waren danach doppelt verschachtelt (Werte blieben heil, sie sind ASCII); repariert durch Zurückrechnen über cp1252. **Für .env-Änderungen kein `Get-Content`/`Set-Content` verwenden.** (2) Der EDB-Installer braucht das Superuser-Passwort als Argument – erzeugt wird es deshalb **im Skript** und landet nur in der `.env`, nie in der Ausgabe. **Nebenbei entfernt:** die tote `REDIS_URL` aus der `.env` (Redis ist seit `b9fa552` raus).

- [x] **Test-Datenbank + Race-Condition-Test (die seit Monaten offene Luecke):** Mit der lokalen PostgreSQL gibt es endlich eine echte Test-DB – Zeilensperren sind Verhalten des Servers und gegen ein gemocktes Prisma **nicht** pruefbar. Neu: `npm run db:test:setup` (`scripts/setup-test-db.ts` legt `lagerhub_test` an und spielt die Migrationen ein; nutzt Prisma statt eines `pg`-Clients, um keine Abhaengigkeit zu ergaenzen), `src/testDb.ts` (leitet die Test-URL aus `DATABASE_URL` ab – **kein zweiter Satz Zugangsdaten**) und `src/testEnv.ts` (Seiteneffekt-Import, der `DATABASE_URL` umbiegt, **bevor** `db.ts` den PrismaClient baut; als Import statt als Zuweisung, weil Zuweisungen im Dateikopf in CommonJS erst nach allen Importen laufen). Beide sind aus `tsconfig.build.json` ausgenommen. Vor jedem Test `TRUNCATE` aller Tabellen ausser `_prisma_migrations`, Tabellenliste aus dem Katalog statt fest verdrahtet. Fehlt die Test-DB, ueberspringt sich die Datei selbst (`ctx.skip()` in `beforeAll`-gesteuerter Huelle – `describe.skip` ginge nicht, weil die Erreichbarkeit erst nach einer Abfrage feststeht und Top-Level-`await` in dieser Modulkonfiguration verboten ist). **Nebenbei:** Fastify-Logger unter `NODE_ENV=test` abgeschaltet, sonst verdeckt eine Wand aus Request-JSON die Fehlermeldungen. Details und die Gegenprobe siehe Eintrag „Tests".

- [x] **Derselbe MA konnte sich mehrfach auf denselben Schritt setzen (Zeit doppelt gezählt):** Gefunden beim Schreiben des Race-Tests – `Assignment` hat keinen Unique-Index auf `(stepId, employeeId)`, und `activateOnStep` prüfte nichts dergleichen. Nachgestellt und gemessen: zweimal einloggen ⇒ zwei `ACTIVE`; dreimal gleichzeitig ⇒ drei; unterbrechen und erneut einloggen ⇒ `PAUSED` + `ACTIVE` **auf einem Schritt mit `maxWorkers: 1`** (PAUSED zählt nicht zur Kapazität); nach dem Abschluss lagen **zwei WorkLog-Zeilen für eine Person auf einem Schritt** in der Auswertung. Fix: Prüfung auf `OFFERED`/`ACTIVE`/`PAUSED` **unter der bestehenden `FOR UPDATE`-Sperre** in `activateOnStep`, vor der Kapazitätsprüfung (damit „schon eingesetzt" die genauere Meldung gewinnt); `DONE`/`REJECTED` und das eigene Angebot (`promoteAssignmentId`) ausgenommen. Kostet **keine** zusätzliche Abfrage – der vorhandene `assignments`-Include wurde um `OFFERED` und zwei Felder erweitert. 5 neue Tests, ebenfalls gegen den kaputten Zustand geprüft (Prüfung deaktiviert ⇒ genau die drei Regel-Tests rot, die beiden Ausnahme-Tests bleiben grün, wie sie müssen). **Kein Datenaufräumen nötig:** die neue lokale DB ist leer. **Bewusst nicht gemacht:** ein partieller Unique-Index in der DB – Prisma 5 kann partielle Indizes nicht im Schema abbilden, das ergäbe dauerhaft Drift bei `migrate dev`. **Verbleibend:** die gleiche Prüfung in `POST /offer` läuft ohne Sperre und ist damit theoretisch überholbar – zwei gleichzeitige Angebote an denselben MA. Folgen gering (ein Angebot belegt keinen Platz, das zweite verfällt), deshalb offen gelassen.

- [x] **Abhängigkeiten auf den aktuellen Stand gebracht (23.09.2026) – Fastify 5, Prisma 7, zod 4, Vitest 5, Vite 8, TypeScript 7:** Der Rückstand war fast überall ein Major-Sprung. Vorgehen in Gruppen mit Typecheck + Tests nach **jedem** Schritt, damit ein Bruch zuordenbar bleibt; Ausgangsbasis war vorher grün abgesichert (144 Tests, alle drei Builds). Ergebnis: **144/144 Tests grün**, alle drei Builds grün, Schwachstellen von 12 (davon 2 kritisch) auf 5 im Backend / 1 im Dashboard / 0 in der PWA – und alle verbleibenden liegen auf Pfaden, die dieses Projekt nicht benutzt (`esbuild`-Dev-Server, `@prisma/config`→`deepmerge-ts` nur bei CLI-Aufrufen, **`mysql2`** als ungenutzte Prisma-Option – wir fahren PostgreSQL –, `xlsx` nur beim **Parsen** fremder Dateien, hier wird nur geschrieben).

  **Drei Fallstricke, die Zeit gekostet hätten:**
  1. **`prisma@latest` ist ein Release Candidate** (`8.0.0-rc.15`) – der `latest`-Tag zeigt dort auf eine Vorabversion, während `@prisma/client@latest` korrekt auf `7.10.0` steht. Ein `npm install prisma@latest` hätte einen RC auf den Firmenserver gebracht. **Vor Prisma-Upgrades immer `npm view prisma dist-tags` prüfen** (`prev` ist dort die stabile Version).
  2. **`relationJoins` ist auch in Prisma 7 noch Preview, nicht GA.** Beim Aufräumen des Generators entfernt – und damit verschwand `relationLoadStrategy` aus den generierten Typen (5 Aufrufstellen). Der Typecheck hat es gefangen; ohne ihn wäre die Read-Performance still auf die alte Multi-SELECT-Kaskade zurückgefallen, ohne einen einzigen Fehler.
  3. **Fail-fast gehört in den Bootstrap, nicht ins DB-Modul.** Der erste Entwurf von `db.ts` warf bei fehlender `DATABASE_URL` schon beim Laden des Moduls – das brach `services/stepStatus.test.ts` ab, der nur die **reine** Funktion `deriveStepStatus` prüft, aber über den Modulbaum `db.ts` mitlädt. Der Treiberadapter verbindet (wie Prisma bis 6) erst beim ersten Query; die Prüfung sitzt jetzt in `src/index.ts` neben dem `JWT_SECRET`-Muster.

  **Der Prisma-7-Umbau ist ein Architekturwechsel, keine Versionsnummer:** `url`/`directUrl` sind im Schema verboten, die Verbindung kommt als **Driver Adapter** (`@prisma/adapter-pg`, bringt `pg` mit), die Migrations-Verbindung aus dem neuen `prisma.config.ts`. Daraus folgt für die Auslieferung: `pack-stick.ps1` prüft jetzt zusätzlich `@prismaadapter-pg`, `pg` **und** die Anwesenheit von `prisma.config.ts` – ohne eines davon startet der Dienst bzw. scheitert `migrate deploy` am Installationstag. `$on("query")` und damit das Logging langsamer Queries (>5 ms) funktioniert unverändert.

  **Kleinere Anpassungen:** Fastify 5 typisiert den Fehler im `setErrorHandler` als `unknown` (`server.ts` liest `statusCode`/`message` jetzt defensiv, Verhalten identisch – beide Frontends lesen weiter `{ error }`); `@types/node-cron` entfernt (node-cron 4 bringt eigene Typen); `setup-test-db.ts` von `datasources` auf den Adapter umgestellt; **`vite-env.d.ts` in beiden Frontends neu** (ohne die Vite-Client-Typen bricht TS 7 den CSS-Seiteneffekt-Import mit TS2882 ab). **Scripts ergänzt:** `migrate:deploy` im Backend (der Befehl für den Installationstag stand vorher nur in der Doku) und `typecheck` in beiden Apps.

  **Verifiziert, nicht nur gebaut** – die Tests berühren den WS-Pfad nie, deshalb end-to-end gegen den gebauten Server geprüft: Start von `dist/index.js` → DB-Verbindung über den Adapter → Login (PIN → JWT) → `wss`-freier `/ws`-Handshake mit Token → `PATCH /settings` mit den **Ist**-Werten → `SETTINGS_UPDATED` kam am Client an; Gegenprobe: WS **ohne** Token wird mit Close **1008** abgewiesen. Dazu `migrate status`/`migrate deploy` gegen die echte DB (20 Migrationen, „up to date"), beide Dev-Server über **HTTPS** unter Vite 8, und `web.config` + Push-Handler im gebauten `sw.js` vorhanden.

  **Grenzen (bewusst):** Vite 8 bundelt mit **Rolldown** statt Rollup – die Bauzeit fiel von ~4,9 s auf ~0,4 s, das Ausgabeformat ist damit aber ein anderes Werkzeug; die gebauten Apps sind über `dist` geprüft, aber **nicht** am echten IIS. `vite-plugin-pwa` warnt beim SW-Build über `inlineDynamicImports` → `codeSplitting: false`; die Warnung kommt aus dem Plugin, nicht aus unserer Config. Die `.env` blieb unangetastet (`DIRECT_URL` wird weiter gelesen, nur von anderer Stelle). **Nicht** am Handy nachgeprüft, ob Push nach dem Plugin-Sprung 0.21→1.3 weiterhin ankommt – der SW enthält die Handler, die Zustellung selbst wurde nicht erneut gemessen.

- [x] **Installationstag: Diagnose der DB-Verbindung + ein Widerspruch in der Doku behoben (23.09.2026):** Bei der Installation auf dem Firmenserver kam **keine Verbindung zur Datenbank** zustande, begleitet von Hinweisen, man müsse Pakete aktualisieren – was dann mit „kritischen Fehlern“ scheiterte. **Gefundene Ursache in der Doku:** `docs/Stick-Liesmich.html` sagt korrekt, dass `npm ci` und `npm run build` **entfallen** (das Paket bringt `node_modules` fertig mit), aber `docs/Installationstag.html` – die Anleitung, der man am Termin Schritt für Schritt folgt – listete in Etappe 5 genau diese Befehle für alle drei Apps. **`npm ci` löscht `node_modules` als Erstes** und lädt neu aus dem Netz; auf dem abgeschotteten Server bricht es ab und hinterlässt einen leeren Baum – danach startet weder der Dienst noch kommt eine DB-Verbindung zustande. Etappe 5 trennt jetzt **Weg A (Paket vom Stick: nichts installieren, nichts bauen)** von **Weg B (Git-Klon, braucht Internet)**; dazu die ausdrückliche Warnung, dass Prismas „Update available“-Hinweis **kein Arbeitsauftrag** ist. Derselbe Hinweis steht in der `Stick-Liesmich.html` und beim Update-Weg am Dokumentende.

  **Neues Werkzeug `npm run db:check`** (`src/scripts/check-db.ts`): beantwortet „warum kommt keine Verbindung zustande?“ in einem Durchlauf und benennt die Ursache im Klartext statt eine rohe pg-Meldung durchzureichen – .env lesbar (BOM-Verdacht) → URL zerlegbar → Port erreichbar → Anmeldung → Schema. Übersetzt die relevanten SQLSTATE-Codes mit Handlungsanweisung (**28P01** Passwort, **3D000** Datenbank fehlt, **28000** `pg_hba.conf`, ECONNREFUSED Dienst). Das Passwort wird nie ausgegeben. **Gegen kaputte Zustände geprüft**, nicht nur im Gutfall: falsches Passwort, fehlende Datenbank, Sonderzeichen-Passwort, toter Port und `.env` mit BOM – jeder Fall wird korrekt benannt.

  **Zweite, noch offene Verdachtsursache – Sonderzeichen im DB-Passwort:** Die Verbindungszeichenfolge ist eine **URL**, ein `@` im Passwort beendet dort den Passwort-Teil. Aus `…lagerhub:pa@ss@localhost…` wird ein Host namens `ss` – die Verbindung läuft ins Leere, **ohne dass die Zeile falsch aussieht**, und die Doku sagte bisher nichts von Kodierung. `db:check` erkennt den Fall heuristisch; Etappe 4 der Installationsanleitung warnt jetzt davor und nennt den `encodeURIComponent`-Einzeiler.

  **Grenze:** Welche der beiden Ursachen am Termin tatsächlich zugeschlagen hat, ist **nicht** belegt – die Fehlermeldungen vom Server lagen nicht vor. Beide sind adressiert; `db:check` entscheidet die Frage beim nächsten Versuch in einem Aufruf.

- [x] **Aufgeräumt (23.09.2026):** Systematisch nach totem Code und überflüssigen Dateien gesucht. **Gelöscht:** `backend/.env.bak` (27.07., ein Geheimnisträger mit JWT-Secret, Crewmeister-Passwort und den alten Admin-PINs im Klartext – per Hash-Vergleich nachgewiesen, dass jeder Wert darin identisch in der aktuellen `.env` steht, bis auf die tote `REDIS_URL` und die alten Supabase-URLs, die als Rückweg ohnehin auskommentiert in der `.env` liegen); `pwa/dev-dist/` (Dev-Überbleibsel); `@types/node-cron` (node-cron 4 bringt eigene Typen mit); sowie auf Entscheidung des Betreibers die beiden **Konzeptdokumente** `.claude/LAGERHUB_Konzept.md` + `.claude/LAGERHUB_Technische_Spezifikation.md` (Stand 02.06., Kapitel 1 nannte FastAPI/Redis/Firebase – alle drei längst abgelöst) und `docs/i18n-pl-entwurf.md` (Übersetzungsentwurf DE→PL, nie umgesetzt).

  > **Die ursprüngliche Spezifikation ist nicht verloren:** `git show dbfd1fe:.claude/LAGERHUB_Technische_Spezifikation.md` (bzw. `…:.claude/LAGERHUB_Konzept.md`, `…:docs/i18n-pl-entwurf.md`). Maßgeblich für den Ist-Zustand ist ohnehin diese Datei; die Geschäftsregeln sind unter „Kernregeln“ vollständig beschrieben.

  **Nichts gefunden bei:** totem Code in den Quellen (alle 19 Kandidaten der Export-Analyse werden in ihrer eigenen Datei genutzt – es sind nur `export`-Marker, die von außen niemand braucht, u. a. der DTO-Katalog in `api/types.ts`, wo genau das der Zweck ist), ungenutzten npm-Paketen, verwaisten Quelldateien (die fünf Treffer in `src/scripts/` sind `npm run`-Ziele), Build-Leichen in `dist/` (der `prebuild` greift), auskommentiertem Code, toten Dateiverweisen in dieser Datei und unvollständigen Migrationen (alle 20 intakt). Die Supabase-Zeilen in den `.env`-Vorlagen **bleiben**: sie sind der dokumentierte Rückweg, kein Rest.

- [x] **Bug-Fixes 03.10.2026:** (1) **Erinnerungs-Entscheidungen fehlten in der Historie** – das Datumsmuster in `GET /stats/journal/reminders` hatte keine Backslashes (`/^d{4}-…/`); ohne Datum (Dashboard) lief es, mit Datum (Historie) gab es 400. (2) **Notizen tragen den Benutzernamen** statt pauschal „Manager“, mit Rolle Manager/Büro/Admin (`NoteAuthorType` um `OFFICE`/`ADMIN` erweitert). (3) **Tagesjournal-Zeiten:** Schritt-Dauer beim Aufklappen, Kopf = Summe der Schritt-Dauern (siehe `JournalRunCard`). (4) **Aufgaben-Reihenfolge per Drag & Drop** (`Task.orderIndex`, `POST /tasks/reorder`). **Nebenbei:** `npm run db:test:setup` brach unter Node 24 mit `spawnSync npx.cmd EINVAL` ab (Node startet `.cmd` ohne Shell nicht mehr) – ruft die Prisma-CLI jetzt direkt über `process.execPath` auf. **Test-DB nach jeder neuen Migration mit `npm run db:test:setup` nachziehen**, sonst scheitern die Race-Tests mit „column does not exist“. 12 neue Tests (gesamt 156).

---

## Hinweise für Claude Code

- **Fastify NICHT umbauen.** Kein Express, kein Socket.io. Der Ereignis-Bus (`events.ts`) ist die einzige Stelle, an der die Verteilung ausgetauscht werden darf.
- Schritt-Status immer ableiten (via `stepStatus.ts`), nie direkt schreiben.
- **Status-Ableitung ohne N+1:** Für mehrere Schritte die Daten gebündelt holen (`stepStatusSelect` + reine `deriveStepStatus`), statt `computeStepStatus` in einer Schleife pro Schritt aufzurufen.
- Bei gleichzeitigen Zuweisungen immer PostgreSQL-Zeilensperre (`FOR UPDATE`).
- **Auth:** Jede neue `/api`-Route braucht einen `preHandler`-Guard aus `auth.ts` (`authAny`/`authDashboard`/`authManager`/`authAdmin`) – die Schutzklasse an der Rolle ausrichten, die die Route nutzt. **Identität (Handeln als MA) NIE aus dem Body/Query nehmen, sondern aus `req.user.sub`/`req.user.role`.** Neues Secret `JWT_SECRET` ist Pflicht (Fail-fast).
- Reihenfolge jeder Aktion: 1. PostgreSQL → 2. `publish()` auf den Ereignis-Bus → 3. /ws verteilt.
- `.env` niemals in Antworten oder Logs ausgeben.
- Migrationen lesen ihre Verbindung aus **`prisma.config.ts`** (dort `DIRECT_URL` vor `DATABASE_URL`), **nicht** mehr aus dem Schema. Neue Umgebungsvariablen für die DB gehören dorthin UND in `src/db.ts`.
- **Frontend:** State über TanStack Query, kein zusätzlicher State-Store, kein Axios. WS nur als Invalidierungs-Signal – neue Backend-Events ggf. in `EVENT_MAP` (`useRealtime.ts`) ergänzen.
- **Doppel-Invalidierung vermeiden:** Mutationen, deren Backend ohnehin ein WS-Event publiziert, sollen nicht zusätzlich selbst invalidieren (siehe Assignment-Mutationen). WS-Invalidierungen laufen gebündelt über `scheduleInvalidate`.
- **Reads über den Pooler:** Bei `findMany`/`findUnique` mit verschachtelten `include`s `relationLoadStrategy: "join"` setzen (Preview `relationJoins` im Schema aktiv), um Roundtrips zu sparen. Einen globalen Konstruktor-Schalter gibt es auch in Prisma 7 nicht; eine Client-Extension bricht die `TransactionClient`-Typen – daher per Query. **`relationJoins` ist auch in Prisma 7 noch Preview, nicht GA**: wird es aus `previewFeatures` entfernt, verschwindet `relationLoadStrategy` aus den generierten Typen und Prisma fällt still auf die alte Multi-SELECT-Kaskade zurück.
