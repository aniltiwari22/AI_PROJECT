# Brings the whole thing up behind one public HTTPS URL.
#
#   powershell -ExecutionPolicy Bypass -File deploy\start-public.ps1
#
# Three processes: the backend, an edge server that puts the frontend and the
# API on one port, and a Cloudflare tunnel pointing at that port.
#
# The single port matters. If the frontend and the API were on different
# origins the browser would try to reach the API on *its own* machine, and
# CORS would have to be opened up to make it work. Same-origin means neither
# problem exists.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cloudflared = "$env:USERPROFILE\.local\bin\cloudflared.exe"

function Say($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }

if (-not (Test-Path $cloudflared)) {
    Say "Downloading cloudflared"
    New-Item -ItemType Directory -Force -Path (Split-Path $cloudflared) | Out-Null
    curl.exe -fL --progress-bar -o $cloudflared `
        "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
}

# The build must carry a relative API base, or it calls localhost:5000 from
# whatever machine opens the URL.
Say "Building the frontend with a relative API base"
Push-Location "$root\frontend"
$env:VITE_API_BASE_URL = '/api/v1'
npx vite build
Pop-Location

Say "Starting the backend"
Start-Process -FilePath "node" -ArgumentList "src\server.js" `
    -WorkingDirectory "$root\backend" -WindowStyle Minimized

Start-Sleep -Seconds 4

Say "Starting the edge server on 8080"
Start-Process -FilePath "node" -ArgumentList "deploy\edge.js" `
    -WorkingDirectory $root -WindowStyle Minimized

Start-Sleep -Seconds 2

# Fail here rather than opening a tunnel to nothing.
try {
    $ping = Invoke-RestMethod -Uri "http://127.0.0.1:8080/ping" -TimeoutSec 10
    Write-Host "    edge is up: $($ping.ok)"
} catch {
    Write-Host "    edge did not come up — check that the backend started" -ForegroundColor Red
    exit 1
}

Say "Opening the tunnel"
Write-Host "    The https://<something>.trycloudflare.com URL appears below."
Write-Host "    It changes every restart. Ctrl-C closes it and takes the site offline.`n"
Write-Host "    Anyone with that link reaches your login page. The password is the" -ForegroundColor Yellow
Write-Host "    only thing protecting 485 conversations and every uploaded document.`n" -ForegroundColor Yellow

& $cloudflared tunnel --url http://127.0.0.1:8080 --no-autoupdate
