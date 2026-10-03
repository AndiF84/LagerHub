# ---------------------------------------------------------------------------
# LagerHub - Uebergabe-Paket schnueren
#
# Erzeugt einen Ordner (und ein ZIP), der so auf einen Stick kopiert und von
# der IT auf den Windows Server ausgerollt werden kann. Der Aufbau folgt genau
# der Uebergabe-Doku: LagerHub\backend\dist als Dienst, frontend\dist und
# pwa\dist als Wurzeln der beiden IIS-Websites.
#
# Die .env liegt AUSGEFUELLT bei (Anweisung des Betreibers, -OhneAdminPins
# schaltet es ab): Admin-PINs, VAPID-Schluessel und Crewmeister-Zugang werden aus
# der lokalen backend\.env uebernommen, JWT_SECRET wird frisch erzeugt. Offen
# bleiben nur das Datenbank-Kennwort und CORS_ORIGIN. Der Stick traegt damit die
# Schluessel zum System UND zur Zeiterfassung - entsprechend zu behandeln.
#
# Bewusst NICHT im Paket:
#   certs\  - private Schluessel der Entwickler-CA, gehoeren zu dieser Maschine.
#   .git\   - die Historie enthaelt alte Admin-PINs; sie gelten als
#             kompromittiert und haben auf einem fremden Rechner nichts zu
#             suchen. Der Quellcode selbst liegt vollstaendig bei.
#
# -Update erzeugt statt der Erstinstallation ein UPDATE-Paket fuer einen
# bereits eingerichteten Server: OHNE .env (die des Servers traegt DB-Kennwort
# und JWT_SECRET und darf nie ueberschrieben werden), ohne Einrichtungs-Doku,
# dafuer mit update.bat/update.ps1, die auf dem Server sichern, austauschen,
# migrieren und bei einem Fehler den alten Stand zurueckholen.
#
# Aufruf:   .\pack-stick.ps1
#           .\pack-stick.ps1 -Ziel D:\ -OhneNeubau
#           .\pack-stick.ps1 -Update
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  # Wohin das Paket geschrieben wird (Standard: Desktop).
  [string] $Ziel = [Environment]::GetFolderPath("Desktop"),
  # Vorhandene dist-Ordner verwenden, statt neu zu bauen.
  [switch] $OhneNeubau,
  # node_modules weglassen - dann braucht der Server beim Einrichten Internet.
  [switch] $Schlank,
  # Kein ZIP erzeugen (nur der Ordner).
  [switch] $OhneZip,
  # Keine vorbelegte .env ins Paket legen - dann legt die IT sie selbst aus
  # .env.production.example an und vergibt eigene Admin-PINs.
  [switch] $OhneAdminPins,
  # Update-Paket fuer einen laufenden Server (ohne .env, mit update.bat).
  [switch] $Update
)

$ErrorActionPreference = "Stop"
# Ein Update-Paket traegt NIE eine .env - sie wuerde die des Servers ersetzen.
if ($Update) { $OhneAdminPins = $true }
$wurzel = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $wurzel

function Schritt($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Hinweis($text) { Write-Host "   $text" -ForegroundColor DarkGray }

# --- 1. Stand festhalten ----------------------------------------------------
$datum = Get-Date -Format "yyyy-MM-dd"
$stand = git rev-parse --short HEAD
if (-not $?) { $stand = "ohne-git" }
if (git status --porcelain) {
  Write-Host "Achtung: es gibt uncommittete Aenderungen. Verpackt wird der Stand" -ForegroundColor Yellow
  Write-Host "des Arbeitsverzeichnisses, nicht der letzte Commit." -ForegroundColor Yellow
}

$name  = if ($Update) { "LagerHub-Update-$datum" } else { "LagerHub-Uebergabe-$datum" }
$stage = Join-Path $Ziel $name
if (Test-Path $stage) {
  Write-Host "Es gibt bereits: $stage" -ForegroundColor Yellow
  $antwort = Read-Host "Ueberschreiben? (j/n)"
  if ($antwort -ne "j") { Write-Host "Abgebrochen."; exit 1 }
  Remove-Item $stage -Recurse -Force
}

# --- 2. Bauen ---------------------------------------------------------------
if ($OhneNeubau) {
  Schritt "Neubau uebersprungen - vorhandene dist-Ordner werden verpackt"
} else {
  Schritt "Bauen (Backend, Dashboard, Handy-App)"
  Push-Location backend
  npm run build
  if ($LASTEXITCODE -ne 0) { Pop-Location; throw "Backend-Build fehlgeschlagen" }
  # prisma generate scheitert mit EPERM, wenn der Entwicklungs-Server laeuft:
  # er haelt query_engine-windows.dll.node offen, und Prisma will sie ersetzen.
  # Das ist kein Grund zum Abbruch, WENN der bereits erzeugte Client zum Schema
  # passt - Prisma legt seine Fassung unter node_modules\.prisma\client ab, und
  # verglichen wird ohne Kommentare und Einrueckung, weil Prisma beim Erzeugen
  # formatiert und nur Modelle/Felder/Enums den Client bestimmen.
  npx prisma generate
  if ($LASTEXITCODE -ne 0) {
    $erzeugt = "node_modules\.prisma\client\schema.prisma"
    if (-not (Test-Path $erzeugt)) { Pop-Location; throw "prisma generate fehlgeschlagen und es liegt kein erzeugter Client vor" }
    function Kern($pfad) {
      (Get-Content $pfad) -replace '//.*', '' -replace '\s+', ' ' |
        ForEach-Object { $_.Trim() } | Where-Object { $_ } | Out-String
    }
    if ((Kern "prisma\schema.prisma") -ne (Kern $erzeugt)) {
      Pop-Location
      throw "prisma generate fehlgeschlagen UND der erzeugte Client passt nicht zum Schema. Laeuft der Entwicklungs-Server? Dann .\stop.ps1, danach erneut packen."
    }
    Write-Host "   prisma generate uebersprungen - der erzeugte Client passt bereits" -ForegroundColor Yellow
    Write-Host "   zum Schema (Unterschied nur Kommentare). Vermutlich haelt der" -ForegroundColor Yellow
    Write-Host "   laufende Entwicklungs-Server die Engine-Datei." -ForegroundColor Yellow
  }
  Pop-Location
  foreach ($app in @("frontend", "pwa")) {
    Push-Location $app
    npm run build
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "$app-Build fehlgeschlagen" }
    Pop-Location
  }
}

foreach ($d in @("backend\dist", "frontend\dist", "pwa\dist")) {
  if (-not (Test-Path $d)) { throw "$d fehlt - einmal ohne -OhneNeubau laufen lassen" }
}

# --- 3. Zusammenstellen -----------------------------------------------------
Schritt "Paket zusammenstellen"
$proj = Join-Path $stage "LagerHub"
New-Item -ItemType Directory -Path $proj -Force | Out-Null

# robocopy: /E = mit Unterordnern, /XD = Ordner aus, /XF = Dateien aus, Rest
# = ruhige Ausgabe. Rueckgabewerte 0-7 sind Erfolg, erst ab 8 ist es ein Fehler.
function Kopiere($von, $nach, [string[]] $ordnerAus, [string[]] $dateienAus) {
  $argumente = @($von, $nach, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1")
  if ($ordnerAus)  { $argumente += "/XD"; $argumente += $ordnerAus }
  if ($dateienAus) { $argumente += "/XF"; $argumente += $dateienAus }
  robocopy @argumente | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Kopieren fehlgeschlagen: $von (robocopy $LASTEXITCODE)" }
}

$ausserOrdner = @(".git", "node_modules", "certs", ".vite", ".claude")
# ".env*" schliesst ALLES Env-Artige aus - auch .env.bak, .env.old, .env.save.
# Eine Aufzaehlung der bekannten Endungen waere die falsche Richtung: was
# jemand kuenftig danebenlegt, waere dann automatisch dabei. Die beiden
# Vorlagen holen wir gleich danach gezielt zurueck.
$ausserGeheim = @(".env*", "*.pfx", "*.key", "*.pem", "*.p12", "tsconfig.tsbuildinfo")

Hinweis "backend  (dist, Quellcode, Prisma-Schema und Migrationen)"
Kopiere "backend" "$proj\backend" $ausserOrdner $ausserGeheim
foreach ($vorlage in @(".env.example", ".env.production.example")) {
  if (Test-Path "backend\$vorlage") { Copy-Item "backend\$vorlage" "$proj\backend\$vorlage" }
}
if (-not (Test-Path "$proj\backend\.env.production.example")) {
  throw "Die Vorlage .env.production.example fehlt im Paket"
}
# prisma.config.ts ist ab Prisma 7 Pflicht: die Verbindungszeichenfolge fuer
# Migrationen steht dort, im Schema ist sie nicht mehr erlaubt. Ohne diese Datei
# scheitert "prisma migrate deploy" am Installationstag.
if (-not (Test-Path "$proj\backend\prisma.config.ts")) {
  throw "prisma.config.ts fehlt im Paket - ohne sie laeuft kein migrate deploy"
}

# --- Vorbelegte .env --------------------------------------------------------
# Auf ausdrueckliche Anweisung des Betreibers wandert die .env AUSGEFUELLT mit,
# damit am Installationstag moeglichst nichts einzutragen ist. Uebernommen werden
# die Admin-PINs, die VAPID-Schluessel und die Crewmeister-Zugangsdaten.
#
# Die Werte kommen aus der lokalen backend\.env und NIE aus diesem Skript - so
# landet kein Geheimnis im versionierten Quelltext (genau der Fehler, der die
# alten PINs seinerzeit kompromittiert hat).
#
# Platzhalter bleiben bewusst:
#   DATABASE_URL/DIRECT_URL - das Kennwort vergibt die IT beim CREATE USER; was
#                             hier steht, muesste sie ohnehin dort verwenden.
#   CORS_ORIGIN             - die Hostnamen der beiden Websites stehen noch nicht fest.
# JWT_SECRET wird FRISCH ERZEUGT statt uebernommen: das Entwicklungs-Secret hat auf
# dem Server nichts zu suchen, und ein leeres Feld liesse den Dienst gar nicht erst
# starten (Fail-fast) - die IT muesste also doch etwas eintragen.
$envImPaket = "$proj\backend\.env"
if ($Update) {
  Hinweis "ohne .env - die des Servers bleibt unangetastet (Update-Paket)"
} elseif ($OhneAdminPins) {
  Hinweis "ohne vorbelegte .env - die IT legt sie aus der Vorlage an"
} else {
  if (-not (Test-Path "backend\.env")) { throw "backend\.env fehlt - sonst gibt es nichts zu uebernehmen" }

  # Zeilenweise ersetzen statt per [regex]::Replace: im Ersatztext von .NET ist
  # "$" ein Sonderzeichen ($1, $&). Ein Passwort mit Dollarzeichen wuerde dort
  # still zerschossen - hier kann das nicht passieren.
  function SetzeEnvZeile {
    param([string[]] $Zeilen, [string] $Schluessel, [string] $NeueZeile)
    $gefunden = $false
    $ergebnis = foreach ($z in $Zeilen) {
      if ($z -match "^\s*$([regex]::Escape($Schluessel))\s*=") { $gefunden = $true; $NeueZeile }
      else { $z }
    }
    if (-not $gefunden) { throw "Schluessel $Schluessel steht nicht in .env.production.example - Vorlage geaendert?" }
    return $ergebnis
  }

  $lokal = Get-Content "backend\.env"
  $zeilen = Get-Content "backend\.env.production.example"

  # Geheimnisse 1:1 aus der lokalen .env uebernehmen.
  $zuUebernehmen = @(
    "ADMIN_PINS",
    "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT",
    "CREWMEISTER_BASE_URL", "CREWMEISTER_USER", "CREWMEISTER_PASSWORD", "CREWMEISTER_CREW_ID"
  )
  foreach ($schluessel in $zuUebernehmen) {
    $quelle = $lokal | Where-Object { $_ -match "^\s*$([regex]::Escape($schluessel))\s*=" } | Select-Object -First 1
    if (-not $quelle) { throw "In backend\.env steht kein $schluessel (sonst -OhneAdminPins verwenden)" }
    $zeilen = SetzeEnvZeile -Zeilen $zeilen -Schluessel $schluessel -NeueZeile $quelle.Trim()
  }

  # Frisches JWT_SECRET - nicht das aus der Entwicklung. 48 Byte aus dem
  # kryptographischen Zufallsgenerator, base64-kodiert.
  $puffer = New-Object byte[] 48
  ([System.Security.Cryptography.RandomNumberGenerator]::Create()).GetBytes($puffer)
  $geheim = [Convert]::ToBase64String($puffer)
  $zeilen = SetzeEnvZeile -Zeilen $zeilen -Schluessel "JWT_SECRET" -NeueZeile "JWT_SECRET=`"$geheim`""

  # CORS_ORIGIN leeren: die Beispiel-Hostnamen der Vorlage waeren schlimmer als
  # nichts - sie sehen echt aus und wuerden jede Anfrage der echten Adressen
  # blockieren. Leer = der Server spiegelt jeden Origin und warnt beim Start.
  $zeilen = SetzeEnvZeile -Zeilen $zeilen -Schluessel "CORS_ORIGIN" -NeueZeile 'CORS_ORIGIN=""'

  # Hinweis oben in die Datei, damit beim Oeffnen sofort klar ist, was noch fehlt.
  $kopf = @(
    "# ===========================================================================",
    "#  BEREITS AUSGEFUELLT - auf Anweisung des Betreibers.",
    "#",
    "#  Uebernommen: Admin-PINs, VAPID-Schluessel, Crewmeister-Zugang.",
    "#  Neu erzeugt: JWT_SECRET (beim Packen gewuerfelt).",
    "#",
    "#  NOCH EINZUTRAGEN - nur diese beiden:",
    "#    1. DATABASE_URL und DIRECT_URL - das Kennwort aus dem CREATE USER.",
    "#       Enthaelt es Sonderzeichen (@ : / ? # % &), muessen sie URL-kodiert",
    "#       werden, sonst zerlegen sie die Adresse. Pruefen mit: npm run db:check",
    "#    2. CORS_ORIGIN - die beiden Website-Adressen, sobald sie feststehen.",
    "#",
    "#  Diese Datei NICHT mit .env.production.example ueberschreiben.",
    "# ===========================================================================",
    ""
  )
  $inhalt = (($kopf + $zeilen) -join "`r`n")

  # Ohne BOM schreiben. Ein BOM in einer .env ist schon einmal teuer geworden
  # (siehe CLAUDE.md, PostgreSQL-Umstellung) - dotenv liest die erste Zeile sonst
  # mitsamt den drei unsichtbaren Bytes.
  [System.IO.File]::WriteAllText($envImPaket, $inhalt, (New-Object System.Text.UTF8Encoding($false)))
  Hinweis "backend\.env vorbelegt: PINs, VAPID, Crewmeister + frisches JWT_SECRET"
}

Hinweis "frontend (dist + Quellcode)"
Kopiere "frontend" "$proj\frontend" $ausserOrdner $ausserGeheim

Hinweis "pwa      (dist + Quellcode)"
Kopiere "pwa" "$proj\pwa" $ausserOrdner $ausserGeheim

Copy-Item "CLAUDE.md" $proj

if (-not $Schlank) {
  Hinweis "backend\node_modules - damit der Server beim Einrichten kein Internet braucht"
  # *.tmp* ausschliessen: abgebrochene `prisma generate`-Laeufe hinterlassen in
  # node_modules\.prisma\client Kopien der Query-Engine als
  # "query_engine-windows.dll.node.tmpNNNN" - je 19 MB, und Prisma raeumt sie nie
  # auf. Am 23.09.2026 lagen dort 19 Stueck = 350 MB, die stillschweigend mit auf
  # den Stick gewandert sind.
  Kopiere "backend\node_modules" "$proj\backend\node_modules" @() @("*.tmp*")
}

if ($Update) {
  Hinweis "update.bat + update.ps1 (fuehren das Update auf dem Server durch)"
  Copy-Item "update.ps1", "update.bat" $stage
} else {
  Hinweis "Doku"
  New-Item -ItemType Directory -Path "$stage\Doku" -Force | Out-Null
  Copy-Item "docs\*.html" "$stage\Doku"
  if (Test-Path "$stage\Doku\Stick-Liesmich.html") {
    Move-Item "$stage\Doku\Stick-Liesmich.html" "$stage\LIESMICH.html" -Force
  }
}

# --- 4. Sicherheitsnetz: nichts Geheimes im Paket ---------------------------
Schritt "Gegenpruefung"
# Alles Env-Artige gilt als verdaechtig, ausser den beiden Vorlagen. Die
# Pruefung wiederholt die Ausschluesse von oben bewusst - sie soll auch dann
# noch greifen, wenn jemand spaeter an der Kopierliste dreht.
$erlaubt = @()
if (-not $OhneAdminPins) { $erlaubt += $envImPaket }
$verboten = Get-ChildItem $stage -Recurse -Force -Include ".env*", "*.pfx", "*.key", "*.pem", "*.p12" -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notlike "*\node_modules\*" -and $_.Name -notlike "*.example" -and $erlaubt -notcontains $_.FullName }
if ($verboten) {
  $verboten | ForEach-Object { Write-Host "  GEFUNDEN: $($_.FullName)" -ForegroundColor Red }
  throw "Es haben Geheimnisse ins Paket gefunden - bitte pruefen, Paket nicht weitergeben."
}
if (Test-Path "$proj\.git") { throw "Git-Historie im Paket - Paket nicht weitergeben." }
# Update: die Pruefung oben laesst Vorlagen (*.example) durch - eine echte .env
# darf es hier aber GAR NICHT geben, update.ps1 bricht sonst ab.
if ($Update -and (Test-Path "$proj\backend\.env")) { throw "Update-Paket enthaelt eine .env - Paket nicht weitergeben." }
Hinweis "keine Schluessel, keine Git-Historie, keine fremde .env"

if (-not $OhneAdminPins) {
  # Gegenprobe: steht ueberall ein echter Wert statt eines Platzhalters? Die
  # Pruefung wiederholt die Befuellung absichtlich - sie soll auch dann greifen,
  # wenn spaeter jemand an der Liste oben dreht.
  $inhalt = Get-Content $envImPaket -Raw
  if ($inhalt -match 'ADMIN_PINS="?\[PIN\]') { throw "Die .env im Paket enthaelt noch den PIN-Platzhalter" }
  if ($inhalt -notmatch 'ADMIN_PINS\s*=\s*"?\d{4}:') { throw "Die .env im Paket enthaelt keine gueltige vierstellige Admin-PIN" }

  # Leer gebliebene Pflichtwerte faenden sonst erst am Installationstag auf.
  foreach ($schluessel in @("JWT_SECRET", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY",
                            "CREWMEISTER_USER", "CREWMEISTER_PASSWORD", "CREWMEISTER_CREW_ID")) {
    if ($inhalt -match "(?m)^$schluessel\s*=\s*`"`"\s*`$") { throw "In der .env im Paket ist $schluessel leer geblieben" }
  }
  # Das Entwicklungs-Secret darf NICHT mitwandern - es muss frisch gewuerfelt sein.
  $devSecret = (Get-Content "backend\.env" | Where-Object { $_ -match '^\s*JWT_SECRET\s*=' } | Select-Object -First 1)
  if ($devSecret -and $inhalt.Contains($devSecret.Trim())) {
    throw "Die .env im Paket traegt das JWT_SECRET aus der Entwicklung - es muss neu erzeugt werden"
  }
  # Die Datenbank-Adresse muss Platzhalter BLEIBEN: das Kennwort der Entwicklung
  # gilt auf dem Server nicht, und ein echt aussehender Wert wuerde niemanden
  # mehr zum Nachtragen bewegen.
  if ($inhalt -notmatch '\[PASSWORT\]') { throw "In der .env im Paket fehlt der Platzhalter [PASSWORT] in DATABASE_URL/DIRECT_URL" }

  Write-Host "   ACHTUNG: das Paket enthaelt eine .env mit Admin-PINs UND den" -ForegroundColor Yellow
  Write-Host "   Crewmeister-Zugangsdaten im Klartext. Der Stick oeffnet damit" -ForegroundColor Yellow
  Write-Host "   auch die Zeiterfassung - entsprechend behandeln." -ForegroundColor Yellow
}

if (-not $Schlank) {
  # @prisma\adapter-pg und pg sind ab Prisma 7 ZWINGEND: die Verbindung kommt
  # nicht mehr aus schema.prisma, sondern wird in src\db.ts als Treiberadapter
  # aufgebaut. Fehlt eines der beiden, startet der Dienst auf dem Server nicht.
  foreach ($modul in @("fastify", "@prisma\client", "@prisma\adapter-pg", "pg", "prisma", "web-push")) {
    if (-not (Test-Path "$proj\backend\node_modules\$modul")) {
      throw "node_modules unvollstaendig: $modul fehlt"
    }
  }
  Hinweis "node_modules vollstaendig (inkl. Prisma-Kommandozeile fuer migrate deploy)"
}

# --- 5. Stand dokumentieren -------------------------------------------------
if ($Update) {
$info = @(
  "LagerHub - Update-Paket",
  "erzeugt am $(Get-Date -Format 'dd.MM.yyyy HH:mm')",
  "Stand:     $stand",
  "Rechner:   $env:COMPUTERNAME",
  "Node:      $(node --version)",
  "",
  "Fuer einen BEREITS EINGERICHTETEN Server. Fuer eine Erstinstallation",
  "ist das falsche Paket (es fehlen .env und Einrichtungs-Doku).",
  "",
  "So geht's:",
  "  1. ZIP entpacken (vorher Rechtsklick - Eigenschaften - Zulassen).",
  "  2. update.bat per Rechtsklick 'Als Administrator ausfuehren'.",
  "     Liegt LagerHub nicht unter C:\LagerHub, in einer Admin-PowerShell:",
  "     .\update.ps1 -Installation D:\LagerHub",
  "",
  "Das Skript sichert die Datenbank (pg_dump), haelt den Dienst an, tauscht die",
  "Programmdateien aus, zieht das Datenbank-Schema nach und startet wieder.",
  "Schlaegt etwas fehl, kommt der alte Stand automatisch zurueck.",
  "Sicherungen und Protokoll: C:\LagerHub-Sicherungen",
  "",
  "Unangetastet bleiben: backend\.env, die Daten, der Windows-Dienst, IIS.",
  "Eine angepasste web.config bleibt erhalten (neue Fassung als web.config.neu).",
  "Benutzer muessen sich nicht neu anmelden.",
  "",
  "Keine .env, keine Schluessel, keine Git-Historie im Paket."
)
} else {
$info = @(
  "LagerHub - Uebergabe-Paket",
  "erzeugt am $(Get-Date -Format 'dd.MM.yyyy HH:mm')",
  "Stand:     $stand",
  "Rechner:   $env:COMPUTERNAME",
  "Node:      $(node --version)",
  "",
  "Inhalt:",
  "  LIESMICH.html   Einstieg - bitte zuerst lesen",
  "  Doku\           Serveruebergabe, Installationstag, IT-Abstimmung",
  "  LagerHub\       kommt 1:1 auf den Server",
  "",
  "Nicht enthalten (mit Absicht): certs\ und die Git-Historie."
)
if ($OhneAdminPins) {
  $info += "Die .env legt die IT aus .env.production.example an."
} else {
  $info += "ACHTUNG: backend\.env ist ausgefuellt und enthaelt im Klartext die"
  $info += "Admin-PINs, die Push-Schluessel UND den Zugang zur Zeiterfassung."
  $info += "Damit oeffnet der Stick auch ein Fremdsystem mit den Arbeitszeiten"
  $info += "aller Mitarbeiter. Nach der Installation loeschen oder wegschliessen."
  $info += ""
  $info += "Noch einzutragen sind nur zwei Werte: das Datenbank-Kennwort in"
  $info += "DATABASE_URL/DIRECT_URL und CORS_ORIGIN. Details stehen oben in der"
  $info += "Datei selbst und in Doku\Installationstag.html (Etappe 4)."
}
}
$info | Set-Content "$stage\PAKET-INFO.txt" -Encoding UTF8

# --- 6. ZIP -----------------------------------------------------------------
$zip = $null
if (-not $OhneZip) {
  Schritt "ZIP erzeugen (schneller zu kopieren als zehntausende Einzeldateien)"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = Join-Path $Ziel "$name.zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $true)
  $pruefsumme = (Get-FileHash $zip -Algorithm SHA256).Hash
  "SHA256  $pruefsumme  $name.zip" | Set-Content "$Ziel\$name.sha256.txt" -Encoding UTF8
  Hinweis $zip
  Hinweis "SHA256 $pruefsumme"
}

# --- 7. Bericht -------------------------------------------------------------
$mb = [math]::Round((Get-ChildItem $stage -Recurse -Force | Measure-Object Length -Sum).Sum / 1MB, 0)
Write-Host ""
Write-Host "Fertig." -ForegroundColor Green
Write-Host "  Ordner: $stage  ($mb MB)"
if ($zip) { Write-Host "  ZIP:    $zip" }
Write-Host ""
if ($Update) {
  Write-Host "Update-Paket: auf dem Server entpacken und update.bat als Administrator" -ForegroundColor DarkGray
  Write-Host "starten. Ablauf steht in PAKET-INFO.txt." -ForegroundColor DarkGray
}
Write-Host "Auf den Stick kopieren - das ZIP genuegt. Auf dem Server nach dem" -ForegroundColor DarkGray
Write-Host "Entpacken einmal Rechtsklick - Eigenschaften - Zulassen, sonst" -ForegroundColor DarkGray
Write-Host "blockiert Windows die Dateien aus fremder Quelle." -ForegroundColor DarkGray
