# LagerHub - beendet Backend, Manager-Dashboard und Mitarbeiter-PWA.
# Aufruf: Doppelklick auf stop.bat  ODER  .\stop.ps1 [-DryRun]
#
# Beendet gezielt die Prozesse, die auf den LagerHub-Ports lauschen,
# plus die von start.ps1 geoeffneten Fenster. Fremde node-Prozesse
# (andere Projekte) bleiben unangetastet.

param(
    [switch]$DryRun   # nur anzeigen, was beendet wuerde
)

$ErrorActionPreference = "Stop"

$ports = @(
    @{ Port = 3000; Name = "Backend" }
    @{ Port = 5173; Name = "Dashboard" }
    @{ Port = 5174; Name = "PWA" }
)

# Prozessnamen, die wir beenden duerfen - alles andere wird nur gemeldet.
$erlaubt = @("node", "powershell", "pwsh", "cmd")

Write-Host ""
Write-Host "  LagerHub wird beendet..." -ForegroundColor Cyan
Write-Host ""

$beendet = 0

# --- 1. Prozesse auf den LagerHub-Ports --------------------------------------
foreach ($p in $ports) {
    $pids = @()
    try {
        $pids = Get-NetTCPConnection -LocalPort $p.Port -State Listen -ErrorAction Stop |
                Select-Object -ExpandProperty OwningProcess -Unique
    } catch {
        # Kein Listener auf diesem Port - nichts zu tun.
    }

    if (-not $pids -or $pids.Count -eq 0) {
        Write-Host ("  {0,-10} Port {1}: laeuft nicht" -f $p.Name, $p.Port) -ForegroundColor DarkGray
        continue
    }

    foreach ($procId in $pids) {
        if ($procId -eq $PID) { continue }

        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }

        if ($erlaubt -notcontains $proc.ProcessName) {
            Write-Host ("  {0,-10} Port {1}: '{2}' (PID {3}) ist kein LagerHub-Prozess - uebersprungen." -f `
                $p.Name, $p.Port, $proc.ProcessName, $procId) -ForegroundColor Yellow
            continue
        }

        if ($DryRun) {
            Write-Host ("  {0,-10} Port {1}: wuerde {2} (PID {3}) beenden" -f `
                $p.Name, $p.Port, $proc.ProcessName, $procId) -ForegroundColor Yellow
        } else {
            try {
                Stop-Process -Id $procId -Force -ErrorAction Stop
                Write-Host ("  {0,-10} Port {1}: beendet ({2}, PID {3})" -f `
                    $p.Name, $p.Port, $proc.ProcessName, $procId) -ForegroundColor Green
                $beendet++
            } catch {
                Write-Host ("  {0,-10} Port {1}: konnte PID {2} nicht beenden - {3}" -f `
                    $p.Name, $p.Port, $procId, $_.Exception.Message) -ForegroundColor Red
            }
        }
    }
}

# --- 2. Die von start.ps1 geoeffneten Fenster --------------------------------
$fenster = Get-Process -ErrorAction SilentlyContinue |
           Where-Object { $_.Id -ne $PID -and $_.MainWindowTitle -like "LagerHub - *" }

foreach ($f in $fenster) {
    if ($DryRun) {
        Write-Host ("  Fenster:    wuerde '{0}' (PID {1}) schliessen" -f $f.MainWindowTitle, $f.Id) -ForegroundColor Yellow
    } else {
        try {
            Stop-Process -Id $f.Id -Force -ErrorAction Stop
            Write-Host ("  Fenster:    '{0}' geschlossen" -f $f.MainWindowTitle) -ForegroundColor Green
            $beendet++
        } catch {
            Write-Host ("  Fenster:    '{0}' liess sich nicht schliessen." -f $f.MainWindowTitle) -ForegroundColor Red
        }
    }
}

Write-Host ""
if ($DryRun) {
    Write-Host "  Testlauf - es wurde nichts beendet." -ForegroundColor Yellow
} elseif ($beendet -eq 0) {
    Write-Host "  Es lief nichts, was zu beenden gewesen waere." -ForegroundColor DarkGray
} else {
    Write-Host "  Fertig - LagerHub ist gestoppt." -ForegroundColor Cyan
}
Write-Host ""

Start-Sleep -Seconds 3
