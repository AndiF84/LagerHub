# ---------------------------------------------------------------------------
# LagerHub - Update auf dem Server einspielen
#
# Liegt im UPDATE-Paket (pack-stick.ps1 -Update) neben dem Ordner LagerHub\ und
# wird auf dem Server als Administrator gestartet (update.bat). Tauscht nur den
# Programmcode aus - alles, was bei der Einrichtung entstanden ist, bleibt:
#   backend\.env (DB-Kennwort, JWT_SECRET, PINs ...), die Datenbank samt Daten,
#   der Windows-Dienst, IIS mit Zertifikat, eine angepasste web.config.
#
# Ablauf:
#   1. Pruefen     - Adminrechte, Installation, Paket vollstaendig, Dienst finden
#   2. Sichern     - Datenbank per pg_dump (vor JEDER Schema-Aenderung Pflicht)
#   3. Anhalten    - Windows-Dienst stoppen
#   4. Austauschen - alte Programmdateien beiseite legen, neue einkopieren
#   5. Datenbank   - Verbindung pruefen (db:check), Schema nachziehen (migrate deploy)
#   6. Starten     - Dienst starten, /health abwarten
# Geht ab Schritt 3 etwas schief, kommen die alten Programmdateien automatisch
# zurueck und der alte Stand wird wieder gestartet.
#
# Aufruf:   update.bat  (Rechtsklick - Als Administrator ausfuehren)
#           .\update.ps1 -Installation D:\LagerHub -Dienst LagerHub
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
  # Wo LagerHub auf dem Server liegt (der Ordner mit backend\, frontend\, pwa\).
  [string] $Installation = "C:\LagerHub",
  # Name des Windows-Dienstes. Leer = automatisch finden (NSSM-Dienst, dessen
  # Arbeitsverzeichnis <Installation>\backend ist).
  [string] $Dienst = "",
  # Wohin Datenbank-Sicherung, alte Programmdateien und Protokoll kommen.
  # Bewusst AUSSERHALB der Installation, damit nichts davon mit ausgetauscht wird.
  [string] $Sicherungen = "C:\LagerHub-Sicherungen",
  # Datenbank-Sicherung auslassen (nur wenn pg_dump fehlt und anders gesichert wurde).
  [switch] $OhneSicherung
)

$ErrorActionPreference = "Stop"
$paket = Join-Path $PSScriptRoot "LagerHub"
$stempel = Get-Date -Format "yyyy-MM-dd_HHmm"

function Schritt($text) { Write-Host ""; Write-Host "== $text" -ForegroundColor Cyan }
function Hinweis($text) { Write-Host "   $text" -ForegroundColor DarkGray }
function Warnung($text) { Write-Host "   $text" -ForegroundColor Yellow }

New-Item -ItemType Directory -Path $Sicherungen -Force | Out-Null
$protokoll = Join-Path $Sicherungen "update-$stempel.log"
Start-Transcript -Path $protokoll | Out-Null

# robocopy: Rueckgabewerte 0-7 sind Erfolg, erst ab 8 ein Fehler.
function Kopiere($von, $nach, [string[]] $zusatz) {
  $argumente = @($von, $nach, "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:2", "/W:2") + $zusatz
  robocopy @argumente | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "Kopieren fehlgeschlagen: $von -> $nach (robocopy $LASTEXITCODE)" }
}

# Port aus der .env des Servers (PORT=...), sonst der Standard 3000.
$apiPort = 3000
$portZeile = Get-Content "$Installation\backend\.env" -ErrorAction SilentlyContinue |
             Where-Object { $_ -match '^\s*PORT\s*=\s*"?(\d+)' } | Select-Object -First 1
if ($portZeile -match '^\s*PORT\s*=\s*"?(\d+)') { $apiPort = [int] $Matches[1] }

function WarteAufHealth([int] $sekunden) {
  $bis = (Get-Date).AddSeconds($sekunden)
  while ((Get-Date) -lt $bis) {
    try {
      $antwort = Invoke-WebRequest "http://localhost:$apiPort/health" -UseBasicParsing -TimeoutSec 3
      if ($antwort.Content -match '"ok"\s*:\s*true') { return $true }
    } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}

# Was im Paket unter backend\ liegt, wird auf dem Server ersetzt; was NUR auf dem
# Server liegt (.env, Protokolle der IT), bleibt unberuehrt. Das Paket enthaelt
# keine .env - die Gegenpruefung unten stellt das sicher.
$backendTeile = @()
$beiseite = Join-Path $Sicherungen "Programm-$stempel"
$ausgetauscht = $false
$dienstGestoppt = $false
$migriert = $false
$dumpDatei = $null

try {
  # --- 1. Pruefen -----------------------------------------------------------
  Schritt "Pruefen"
  $ich = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $ich.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Bitte als Administrator starten (Rechtsklick auf update.bat - Als Administrator ausfuehren)."
  }
  if (-not (Test-Path "$Installation\backend\.env")) {
    throw "Keine Installation unter $Installation gefunden (backend\.env fehlt). Pfad mit -Installation angeben."
  }
  foreach ($pflicht in @("backend\dist\index.js", "backend\prisma\schema.prisma", "backend\prisma.config.ts",
                         "backend\node_modules\prisma\build\index.js", "backend\node_modules\tsx\dist\cli.mjs",
                         "frontend\dist\index.html", "pwa\dist\index.html")) {
    if (-not (Test-Path (Join-Path $paket $pflicht))) { throw "Paket unvollstaendig: $pflicht fehlt" }
  }
  if (Get-ChildItem $paket -Recurse -Force -Filter ".env" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notlike "*\node_modules\*" }) {
    throw "Das Paket enthaelt eine .env - das ist kein Update-Paket. Abgebrochen, damit die .env des Servers nicht ueberschrieben wird."
  }
  $node = (Get-Command node -ErrorAction SilentlyContinue)
  if (-not $node) { throw "Node.js nicht gefunden (node.exe nicht im PATH)." }
  $node = $node.Source

  if (-not $Dienst) {
    $ziel = (Join-Path $Installation "backend").TrimEnd("\")
    $treffer = @(Get-ChildItem "HKLM:\SYSTEM\CurrentControlSet\Services" -ErrorAction SilentlyContinue | Where-Object {
      $p = Get-ItemProperty "$($_.PSPath)\Parameters" -Name AppDirectory -ErrorAction SilentlyContinue
      $p -and ("$($p.AppDirectory)".TrimEnd("\") -eq $ziel)
    } | ForEach-Object { $_.PSChildName })
    if ($treffer.Count -ne 1) {
      throw "Windows-Dienst nicht eindeutig gefunden ($($treffer.Count) Treffer). Name mit -Dienst angeben (steht in der Notiz vom Installationstag, Etappe 6)."
    }
    $Dienst = $treffer[0]
  }
  $dienstObj = Get-Service -Name $Dienst
  Hinweis "Installation: $Installation"
  Hinweis "Dienst:       $Dienst ($($dienstObj.Status))"
  $infoDatei = Join-Path $PSScriptRoot "PAKET-INFO.txt"
  if (Test-Path $infoDatei) { Get-Content $infoDatei | Select-Object -First 3 | ForEach-Object { Hinweis $_ } }

  # --- 2. Datenbank sichern -------------------------------------------------
  Schritt "Datenbank sichern"
  if ($OhneSicherung) {
    Warnung "uebersprungen (-OhneSicherung)"
  } else {
    $zeile = Get-Content "$Installation\backend\.env" | Where-Object { $_ -match '^\s*DATABASE_URL\s*=' } | Select-Object -First 1
    if (-not $zeile) { throw "DATABASE_URL steht nicht in backend\.env" }
    $wert = ($zeile -replace '^\s*DATABASE_URL\s*=\s*', '').Trim().Trim('"').Trim("'")
    $url = [Uri] $wert
    $teile = $url.UserInfo.Split(":", 2)
    $dbName = $url.AbsolutePath.TrimStart("/")
    $port = if ($url.Port -gt 0) { $url.Port } else { 5432 }

    $pgDump = Get-ChildItem "C:\Program Files\PostgreSQL\*\bin\pg_dump.exe" -ErrorAction SilentlyContinue |
              Sort-Object { [int]($_.Directory.Parent.Name -replace '\D', '') } -Descending | Select-Object -First 1
    if (-not $pgDump) { $pgDump = Get-Command pg_dump -ErrorAction SilentlyContinue }
    if (-not $pgDump) { throw "pg_dump nicht gefunden. Datenbank anders sichern und mit -OhneSicherung erneut starten." }
    $pgDumpPfad = if ($pgDump.FullName) { $pgDump.FullName } else { $pgDump.Source }

    $dumpDatei = Join-Path $Sicherungen "lagerhub-$stempel.dump"
    # Kennwort nur fuer diesen einen Aufruf in die Umgebung - nie auf die
    # Kommandozeile (dort waere es in der Prozessliste sichtbar).
    $dbBenutzer = [Uri]::UnescapeDataString($teile[0])
    $env:PGPASSWORD = if ($teile.Count -gt 1) { [Uri]::UnescapeDataString($teile[1]) } else { "" }
    try {
      & $pgDumpPfad -h $url.Host -p $port -U $dbBenutzer -d $dbName -Fc -f $dumpDatei
      $code = $LASTEXITCODE
    } finally {
      Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
    }
    if ($code -ne 0 -or -not (Test-Path $dumpDatei) -or (Get-Item $dumpDatei).Length -eq 0) {
      throw "pg_dump fehlgeschlagen (Code $code) - Update abgebrochen, es wurde noch nichts veraendert."
    }
    Hinweis "$dumpDatei ($([math]::Round((Get-Item $dumpDatei).Length / 1KB)) KB)"
  }

  # --- 3. Dienst anhalten ---------------------------------------------------
  Schritt "Dienst anhalten"
  if ($dienstObj.Status -ne "Stopped") {
    Stop-Service -Name $Dienst -Force
    $dienstObj.WaitForStatus("Stopped", (New-TimeSpan -Seconds 60))
  }
  $dienstGestoppt = $true
  Hinweis "angehalten"

  # --- 4. Austauschen -------------------------------------------------------
  Schritt "Programmdateien austauschen"
  New-Item -ItemType Directory -Path "$beiseite\backend" -Force | Out-Null

  # Backend: alte Teile VERSCHIEBEN (sofort, auch bei ~550 MB node_modules) -
  # das ist zugleich die Sicherung fuer den Rueckweg.
  $backendTeile = @(Get-ChildItem (Join-Path $paket "backend") -Force | ForEach-Object { $_.Name })
  $ausgetauscht = $true
  foreach ($teil in $backendTeile) {
    $alt = Join-Path "$Installation\backend" $teil
    if (Test-Path $alt) { Move-Item $alt (Join-Path "$beiseite\backend" $teil) }
  }
  foreach ($teil in $backendTeile) {
    $quelle = Join-Path "$paket\backend" $teil
    if ((Get-Item $quelle).PSIsContainer) { Kopiere $quelle (Join-Path "$Installation\backend" $teil) @("/E") }
    else { Copy-Item $quelle (Join-Path "$Installation\backend" $teil) }
  }
  Hinweis "backend  ersetzt (.env unveraendert)"

  # Dashboard + Handy-App: dist wird gespiegelt statt verschoben - IIS kann
  # Dateien darin gerade offen halten, ein Verschieben des Ordners scheitert
  # dann. Vorher eine Kopie fuer den Rueckweg.
  foreach ($app in @("frontend", "pwa")) {
    $dist = "$Installation\$app\dist"
    if (Test-Path $dist) { Kopiere $dist "$beiseite\$app\dist" @("/E") }
    # web.config NICHT ueberschreiben, falls die IT sie angepasst hat (z. B.
    # X-Forwarded-For, siehe Installationsanleitung). Die neue Fassung landet
    # dann daneben als web.config.neu - zum Vergleichen.
    $altCfg = "$dist\web.config"
    $neuCfg = "$paket\$app\dist\web.config"
    $cfgBehalten = (Test-Path $altCfg) -and (Test-Path $neuCfg) -and
                   ((Get-FileHash $altCfg).Hash -ne (Get-FileHash $neuCfg).Hash)
    Kopiere "$paket\$app\dist" $dist @("/MIR", "/XF", "web.config", "web.config.neu")
    if ($cfgBehalten) {
      Copy-Item $neuCfg "$dist\web.config.neu" -Force
      Warnung "$app\dist\web.config weicht vom Paket ab - die vorhandene bleibt,"
      Warnung "die neue liegt als web.config.neu daneben. Bitte vergleichen."
    } elseif (Test-Path $neuCfg) {
      Copy-Item $neuCfg "$dist\web.config" -Force
    }
    # Quellcode daneben aktualisieren (nur zur Ansicht/fuer einen Neubau).
    Get-ChildItem "$paket\$app" -Force | Where-Object { $_.Name -ne "dist" } | ForEach-Object {
      if ($_.PSIsContainer) { Kopiere $_.FullName "$Installation\$app\$($_.Name)" @("/E") }
      else { Copy-Item $_.FullName "$Installation\$app\$($_.Name)" -Force }
    }
    Hinweis "$app ersetzt"
  }
  if (Test-Path "$paket\CLAUDE.md") { Copy-Item "$paket\CLAUDE.md" "$Installation\CLAUDE.md" -Force }

  # --- 5. Datenbank ---------------------------------------------------------
  Schritt "Datenbank pruefen und Schema nachziehen"
  Push-Location "$Installation\backend"
  try {
    # Gleiche Diagnose wie npm run db:check - nur ohne npm (der .cmd-Umweg ist
    # unter neueren Node-Versionen aus Skripten heraus unzuverlaessig).
    & $node "node_modules\tsx\dist\cli.mjs" "src\scripts\check-db.ts"
    if ($LASTEXITCODE -ne 0) { throw "Keine Verbindung zur Datenbank (Diagnose oben). Es wurde noch nichts an der Datenbank geaendert." }
    $migriert = $true
    & $node "node_modules\prisma\build\index.js" migrate deploy
    if ($LASTEXITCODE -ne 0) { throw "prisma migrate deploy fehlgeschlagen (Meldung oben)." }
  } finally {
    Pop-Location
  }

  # --- 6. Starten -----------------------------------------------------------
  Schritt "Dienst starten"
  Start-Service -Name $Dienst
  if (-not (WarteAufHealth 60)) {
    throw "Der Dienst antwortet nach 60 s nicht auf /health. Ereignisanzeige bzw. NSSM-Protokoll pruefen."
  }
  Hinweis "/health antwortet mit {`"ok`":true}"

  if (Test-Path $infoDatei) { Copy-Item $infoDatei "$Installation\VERSION.txt" -Force }

  # Alte Programmstaende aufraeumen: die letzten drei bleiben fuer den Notfall.
  Get-ChildItem $Sicherungen -Directory -Filter "Programm-*" | Sort-Object Name -Descending |
    Select-Object -Skip 3 | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

  Write-Host ""
  Write-Host "Update erfolgreich." -ForegroundColor Green
  Hinweis "Alter Programmstand: $beiseite"
  if ($dumpDatei) { Hinweis "Datenbank-Sicherung: $dumpDatei" }
  Hinweis "Protokoll:           $protokoll"
  Hinweis "Dashboard und Handy-App laden die neue Fassung beim naechsten Oeffnen;"
  Hinweis "angemeldete Benutzer bleiben angemeldet."
}
catch {
  Write-Host ""
  Write-Host "FEHLER: $($_.Exception.Message)" -ForegroundColor Red

  if ($ausgetauscht) {
    Write-Host ""
    Write-Host "== Rueckweg: alter Programmstand wird wiederhergestellt" -ForegroundColor Yellow
    try {
      Stop-Service -Name $Dienst -Force -ErrorAction SilentlyContinue
      foreach ($teil in $backendTeile) {
        $neu = Join-Path "$Installation\backend" $teil
        $alt = Join-Path "$beiseite\backend" $teil
        if (Test-Path $alt) {
          if (Test-Path $neu) { Remove-Item $neu -Recurse -Force }
          Move-Item $alt $neu
        }
      }
      foreach ($app in @("frontend", "pwa")) {
        if (Test-Path "$beiseite\$app\dist") { Kopiere "$beiseite\$app\dist" "$Installation\$app\dist" @("/MIR") }
      }
      Start-Service -Name $Dienst
      if (WarteAufHealth 60) {
        Write-Host "   Alter Stand laeuft wieder (/health ok)." -ForegroundColor Yellow
      } else {
        Write-Host "   Alter Stand zurueckkopiert, antwortet aber nicht auf /health." -ForegroundColor Red
      }
    } catch {
      Write-Host "   Rueckweg fehlgeschlagen: $($_.Exception.Message)" -ForegroundColor Red
      Write-Host "   Die alten Dateien liegen unter $beiseite" -ForegroundColor Red
    }
  } elseif ($dienstGestoppt) {
    Start-Service -Name $Dienst -ErrorAction SilentlyContinue
  }

  if ($migriert -and $dumpDatei) {
    Write-Host ""
    Write-Host "   Die Datenbank-Migration wurde begonnen. Neue Spalten/Tabellen stoeren" -ForegroundColor Yellow
    Write-Host "   den alten Stand in der Regel nicht. Nur falls doch, Sicherung zurueckspielen:" -ForegroundColor Yellow
    Write-Host "   pg_restore --clean --if-exists -h $($url.Host) -p $port -U $dbBenutzer -d $dbName `"$dumpDatei`"" -ForegroundColor Yellow
  }
  Write-Host ""
  Write-Host "   Protokoll: $protokoll" -ForegroundColor DarkGray
  Stop-Transcript | Out-Null
  exit 1
}

Stop-Transcript | Out-Null
exit 0
