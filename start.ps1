# LagerHub - startet Backend, Manager-Dashboard und Mitarbeiter-PWA in je einem Fenster.
# Aufruf: Doppelklick auf start.bat  ODER  .\start.ps1 [-NoBrowser] [-Prod]

param(
    [switch]$NoBrowser,   # Browser nicht automatisch oeffnen
    [switch]$Prod         # Produktions-Build starten statt Dev-Server
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

Write-Host ""
Write-Host "  LagerHub wird gestartet..." -ForegroundColor Cyan
Write-Host ""

# --- Voraussetzungen pruefen -------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "  FEHLER: Node.js wurde nicht gefunden." -ForegroundColor Red
    Write-Host "  Bitte von https://nodejs.org installieren (Version 22 oder neuer)."
    Read-Host "`n  Enter zum Beenden"
    exit 1
}

if (-not (Test-Path (Join-Path $root "backend\.env"))) {
    Write-Host "  FEHLER: backend\.env fehlt." -ForegroundColor Red
    Write-Host "  Vorlage kopieren: copy backend\.env.example backend\.env"
    Read-Host "`n  Enter zum Beenden"
    exit 1
}

# --- HTTPS-Zertifikat sicherstellen -----------------------------------------
# Ohne Zertifikat laufen die Dev-Server ueber http - dann fehlt der Secure
# Context und Web-Push/PWA-Installation funktionieren nicht.
if (-not (Test-Path (Join-Path $root "certs\lagerhub-dev.crt"))) {
    Write-Host "  Kein HTTPS-Zertifikat gefunden - wird jetzt erzeugt..." -ForegroundColor Yellow
    & (Join-Path $root "dev-certs.ps1")
    # Auf die Datei pruefen, nicht auf $LASTEXITCODE: ein erfolgreiches
    # PowerShell-Skript setzt den Code nicht, der Wert waere also von vorher.
    if (-not (Test-Path (Join-Path $root "certs\lagerhub-dev.crt"))) {
        Write-Host "  FEHLER: Zertifikat konnte nicht erzeugt werden." -ForegroundColor Red
        Read-Host "`n  Enter zum Beenden"
        exit 1
    }
}

$parts = @(
    @{ Name = "Backend";   Dir = "backend";  Url = $null;                    Dev = "npm run dev"; Prod = "npm start" }
    @{ Name = "Dashboard"; Dir = "frontend"; Url = "https://localhost:5173";  Dev = "npm run dev"; Prod = "npm run preview" }
    @{ Name = "PWA";       Dir = "pwa";      Url = "https://localhost:5174";  Dev = "npm run dev"; Prod = "npm run preview" }
)

foreach ($p in $parts) {
    $modules = Join-Path $root "$($p.Dir)\node_modules"
    if (-not (Test-Path $modules)) {
        Write-Host "  Pakete fehlen in $($p.Dir) - installiere (das dauert einen Moment)..." -ForegroundColor Yellow
        Push-Location (Join-Path $root $p.Dir)
        npm install
        Pop-Location
    }
}

# --- Bei -Prod zuerst bauen --------------------------------------------------
if ($Prod) {
    Write-Host "  Produktions-Build wird erstellt..." -ForegroundColor Yellow
    foreach ($p in $parts) {
        Push-Location (Join-Path $root $p.Dir)
        npm run build
        if ($LASTEXITCODE -ne 0) {
            Pop-Location
            Write-Host "  FEHLER: Build in $($p.Dir) fehlgeschlagen." -ForegroundColor Red
            Read-Host "`n  Enter zum Beenden"
            exit 1
        }
        Pop-Location
    }
}

# --- Die drei Teile in eigenen Fenstern starten ------------------------------
foreach ($p in $parts) {
    $dir = Join-Path $root $p.Dir
    $cmd = if ($Prod) { $p.Prod } else { $p.Dev }
    $inner = "`$host.UI.RawUI.WindowTitle = 'LagerHub - $($p.Name)'; Set-Location '$dir'; $cmd"
    Start-Process powershell -ArgumentList "-NoExit", "-Command", $inner | Out-Null
    Write-Host ("  gestartet: {0,-10} ({1})" -f $p.Name, $p.Dir) -ForegroundColor Green
}

Write-Host ""
Write-Host "  Dashboard:       https://localhost:5173"
Write-Host "  Mitarbeiter-App: https://localhost:5174"

# LAN-Adresse fuer Handy/Tablet - steckt mit im Zertifikat.
$lan = Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.PrefixOrigin -eq "Dhcp" -and $_.IPAddress -notlike "169.254.*" } |
       Select-Object -First 1 -ExpandProperty IPAddress
if ($lan) {
    Write-Host "  Am Handy:        https://${lan}:5174" -ForegroundColor DarkGray
}
Write-Host "  Backend/API:     http://localhost:3000 (nur intern, wie hinter IIS)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Zum Beenden die drei Fenster schliessen (oder dort Strg+C)." -ForegroundColor DarkGray
Write-Host ""

# --- Warten bis das Dashboard antwortet, dann Browser oeffnen -----------------
if (-not $NoBrowser) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Write-Host "  Warte auf das Dashboard..." -NoNewline
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            Invoke-WebRequest -Uri "https://localhost:5173" -UseBasicParsing -TimeoutSec 2 | Out-Null
            $ok = $true
            break
        } catch {
            Write-Host "." -NoNewline
        }
    }
    Write-Host ""
    if ($ok) {
        Start-Process "https://localhost:5173"
    } else {
        Write-Host "  Dashboard antwortet noch nicht - bitte im Fenster 'LagerHub - Dashboard' nachsehen." -ForegroundColor Yellow
    }
}

Start-Sleep -Seconds 3
