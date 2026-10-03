# LagerHub - erzeugt ein lokales HTTPS-Zertifikat fuer die Entwicklung.
# Aufruf: .\dev-certs.ps1 [-Force]
#
# Warum eine eigene Mini-CA statt eines einzelnen selbstsignierten Zertifikats:
# nur so kann ein Handy EINMAL die CA installieren und vertraut danach jedem
# neuen Zertifikat, das hier erzeugt wird (z. B. nach einem IP-Wechsel).
# Ohne vertrauenswuerdiges Zertifikat registriert Chrome keinen Service Worker
# -> kein Web-Push, keine Installation der PWA.

param(
    [switch]$Force   # Zertifikate neu erzeugen, auch wenn sie schon existieren
)

$ErrorActionPreference = "Stop"
$root     = $PSScriptRoot
$certDir  = Join-Path $root "certs"
$caKey    = Join-Path $certDir "lagerhub-dev-ca.key"
$caCrt    = Join-Path $certDir "lagerhub-dev-ca.crt"
$srvKey   = Join-Path $certDir "lagerhub-dev.key"
$srvCrt   = Join-Path $certDir "lagerhub-dev.crt"

# --- openssl finden (Git for Windows bringt es mit) --------------------------
$openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
if (-not $openssl) {
    foreach ($c in @("$env:ProgramFiles\Git\usr\bin\openssl.exe",
                     "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
                     "$env:LOCALAPPDATA\Programs\Git\usr\bin\openssl.exe")) {
        if (Test-Path $c) { $openssl = $c; break }
    }
}
if (-not $openssl) {
    Write-Host "  FEHLER: openssl nicht gefunden (kommt normalerweise mit Git for Windows)." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $certDir)) { New-Item -ItemType Directory -Path $certDir | Out-Null }

# --- openssl-Aufruf ohne PowerShell-5.1-Stolperstein ------------------------
# Native Programme, deren stderr in PowerShell 5.1 umgeleitet wird, erzeugen
# NativeCommandError - openssl schreibt seine Fortschrittspunkte dorthin.
# Deshalb laeuft der Aufruf ueber Start-Process mit Datei-Umleitung.
$errLog = Join-Path $certDir "_openssl.log"
function Invoke-OpenSsl {
    param([string[]]$Arguments, [string]$Step)
    # PS 5.1 zerlegt ein Argument-Array an Leerzeichen - Werte mit Leerzeichen
    # (z. B. der Zertifikatsname) muessen deshalb selbst gequotet werden.
    $line = ($Arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $p = Start-Process -FilePath $openssl -ArgumentList $line -NoNewWindow -Wait -PassThru `
                       -RedirectStandardError $errLog
    if ($p.ExitCode -ne 0) {
        Write-Host "  FEHLER bei: $Step" -ForegroundColor Red
        if (Test-Path $errLog) { Get-Content $errLog | Write-Host }
        exit 1
    }
}


# --- Adressen sammeln, unter denen die Server erreichbar sein sollen ---------
$names = @("localhost", $env:COMPUTERNAME.ToLower())
$ips   = @("127.0.0.1", "::1")
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
    ForEach-Object { $ips += $_.IPAddress }
$names = $names | Select-Object -Unique
$ips   = $ips   | Select-Object -Unique

Write-Host ""
Write-Host "  Zertifikat wird ausgestellt fuer:" -ForegroundColor Cyan
Write-Host "    Namen:    $($names -join ', ')"
Write-Host "    Adressen: $($ips -join ', ')"
Write-Host ""

# --- CA erzeugen (nur einmal - sonst muesste das Handy sie neu bekommen) -----
if ($Force -or -not (Test-Path $caCrt)) {
    Write-Host "  Erzeuge lokale CA..." -ForegroundColor Yellow
    Invoke-OpenSsl -Step "CA erzeugen" -Arguments @(
        "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
        "-keyout", $caKey, "-out", $caCrt,
        "-subj", "/CN=LagerHub Dev CA/O=LagerHub",
        "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
        "-addext", "keyUsage=critical,keyCertSign,cRLSign")
} else {
    Write-Host "  Vorhandene CA wird wiederverwendet (Handy behaelt sein Vertrauen)."
}

# --- Server-Zertifikat von der CA signieren ---------------------------------
$sanLines = @()
$i = 1; foreach ($n in $names) { $sanLines += "DNS.$i = $n"; $i++ }
$i = 1; foreach ($p in $ips)   { $sanLines += "IP.$i = $p";  $i++ }

$extFile = Join-Path $certDir "_ext.cnf"
@"
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
$($sanLines -join "`n")
"@ | Out-File -FilePath $extFile -Encoding ascii

$csr = Join-Path $certDir "_server.csr"
Invoke-OpenSsl -Step "Schluessel/Anfrage erzeugen" -Arguments @(
    "req", "-newkey", "rsa:2048", "-nodes", "-keyout", $srvKey, "-out", $csr, "-subj", "/CN=lagerhub-dev")
Invoke-OpenSsl -Step "Zertifikat signieren" -Arguments @(
    "x509", "-req", "-in", $csr, "-CA", $caCrt, "-CAkey", $caKey, "-CAcreateserial",
    "-out", $srvCrt, "-days", "825", "-sha256", "-extfile", $extFile)
Remove-Item $csr, $extFile, $errLog -ErrorAction SilentlyContinue

# --- CA in den Windows-Zertifikatsspeicher (nur dieser Benutzer) ------------
$thumb = (New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $caCrt).Thumbprint
if (-not (Test-Path "Cert:\CurrentUser\Root\$thumb")) {
    Write-Host "  CA wird als vertrauenswuerdig eingetragen (nur dieser Benutzer)..." -ForegroundColor Yellow
    # certutil statt Import-Certificate: letzteres verlangt fuer den Root-Speicher
    # einen Bestaetigungsdialog und scheitert ohne Benutzeroberflaeche.
    certutil -user -addstore Root $caCrt | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  CA konnte nicht eingetragen werden - der Browser wird warnen." -ForegroundColor Yellow
    }
} else {
    Write-Host "  CA ist bereits als vertrauenswuerdig eingetragen."
}

Write-Host ""
Write-Host "  Fertig." -ForegroundColor Green
Write-Host "    Zertifikat: certs\lagerhub-dev.crt"
Write-Host "    CA fuers Handy: certs\lagerhub-dev-ca.crt"
Write-Host ""
