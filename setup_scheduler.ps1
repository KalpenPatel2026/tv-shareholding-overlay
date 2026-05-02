# Register two Windows scheduled tasks:
#   1. TVOverlay_Server  -> runs data_server.py at user logon (always-on background)
#   2. TVOverlay_Scrape  -> runs scrape_shareholding.py daily at 21:30 IST
#
# Run from an ELEVATED PowerShell:
#   powershell -ExecutionPolicy Bypass -File setup_scheduler.ps1
#
# Uninstall:
#   Unregister-ScheduledTask -TaskName TVOverlay_Server -Confirm:$false
#   Unregister-ScheduledTask -TaskName TVOverlay_Scrape -Confirm:$false

$ErrorActionPreference = "Stop"

# Resolve paths relative to this script
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = (Get-Command python).Source
if (-not $python) { throw "python.exe not on PATH. Install Python 3.10+ and re-run." }

$server = Join-Path $here "data_server.py"
$scrape = Join-Path $here "scrape_shareholding.py"
$logDir = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

# --- Task 1: data_server (logon trigger, restart on failure) ---
$action1 = New-ScheduledTaskAction `
  -Execute $python `
  -Argument "`"$server`"" `
  -WorkingDirectory $here

$trigger1 = New-ScheduledTaskTrigger -AtLogOn

$settings1 = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 5 `
  -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName "TVOverlay_Server" `
  -Action $action1 -Trigger $trigger1 -Settings $settings1 `
  -Description "Local data server for TV Shareholding Overlay extension" `
  -Force | Out-Null
Write-Host "Registered TVOverlay_Server (runs at logon)."

# --- Task 2: scraper (daily 21:30) ---
$action2 = New-ScheduledTaskAction `
  -Execute $python `
  -Argument "`"$scrape`" --resume" `
  -WorkingDirectory $here

$trigger2 = New-ScheduledTaskTrigger -Daily -At 9:30PM

$settings2 = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 4)

Register-ScheduledTask -TaskName "TVOverlay_Scrape" `
  -Action $action2 -Trigger $trigger2 -Settings $settings2 `
  -Description "Daily scrape of promoter / pledge / RPT for TV Overlay" `
  -Force | Out-Null
Write-Host "Registered TVOverlay_Scrape (daily 21:30)."

Write-Host ""
Write-Host "Done. Start the server now without waiting for next logon:"
Write-Host "  Start-ScheduledTask -TaskName TVOverlay_Server"
Write-Host ""
Write-Host "Trigger first scrape immediately:"
Write-Host "  Start-ScheduledTask -TaskName TVOverlay_Scrape"
