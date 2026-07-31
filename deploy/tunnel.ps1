# Keeps a public tunnel alive on a connection that drops.
#
#   powershell -ExecutionPolicy Bypass -File deploy\tunnel.ps1
#
# Two things this does that `cloudflared tunnel --url` alone does not.
#
# 1. Forces HTTP/2 instead of QUIC. cloudflared prefers QUIC, which runs over
#    UDP, and UDP is the first thing to die behind an aggressive NAT or an ISP
#    that throttles it. Measured on this connection: the control stream failed
#    534 times in one session, and Telegram's long-poll failed 132 times over
#    the same period — the network, not Cloudflare.
#
# 2. Restarts when the tunnel dies rather than sitting in cloudflared's own
#    retry loop. That loop keeps the process alive while the hostname has
#    already been withdrawn from DNS, so the site is down but nothing looks
#    wrong. A fresh process gets a fresh URL, printed below.

$ErrorActionPreference = 'Stop'
$cloudflared = "$env:USERPROFILE\.local\bin\cloudflared.exe"
$logDir = Join-Path $env:TEMP 'ashu-tunnel'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

if (-not (Test-Path $cloudflared)) {
    Write-Host "cloudflared not found. Run deploy\start-public.ps1 first." -ForegroundColor Red
    exit 1
}

# Refuse to open a tunnel to nothing.
try {
    Invoke-RestMethod -Uri 'http://127.0.0.1:8080/ping' -TimeoutSec 5 | Out-Null
} catch {
    Write-Host "Nothing is listening on 8080. Start the backend and edge first." -ForegroundColor Red
    exit 1
}

Write-Host "Watching. Ctrl-C stops the tunnel and takes the site offline.`n" -ForegroundColor Cyan

$attempt = 0
while ($true) {
    $attempt++
    $log = Join-Path $logDir "tunnel-$attempt.log"

    Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 1

    $proc = Start-Process -FilePath $cloudflared `
        -ArgumentList 'tunnel', '--url', 'http://127.0.0.1:8080', `
                      '--protocol', 'http2', '--no-autoupdate' `
        -NoNewWindow -PassThru -RedirectStandardOutput $log -RedirectStandardError "$log.err"

    # The URL appears a few seconds in.
    $url = $null
    foreach ($i in 1..30) {
        Start-Sleep -Seconds 1
        $text = (Get-Content $log, "$log.err" -ErrorAction SilentlyContinue) -join "`n"
        $m = [regex]::Match($text, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($m.Success) { $url = $m.Value; break }
    }

    if ($url) {
        Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $url) -ForegroundColor Green
        $url | Set-Content (Join-Path $logDir 'current-url.txt')
    } else {
        Write-Host ("[{0}] no URL yet — see {1}" -f (Get-Date -Format 'HH:mm:ss'), $log) -ForegroundColor Yellow
    }

    # Poll the tunnel from outside rather than trusting the process to exit.
    # cloudflared stays alive in a retry loop long after the hostname is gone.
    while (-not $proc.HasExited) {
        Start-Sleep -Seconds 20
        if (-not $url) { break }
        try {
            Invoke-RestMethod -Uri "$url/ping" -TimeoutSec 15 | Out-Null
        } catch {
            Write-Host ("[{0}] tunnel stopped answering — restarting" -f (Get-Date -Format 'HH:mm:ss')) -ForegroundColor Yellow
            break
        }
    }

    Write-Host "  restarting in 5s`n" -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
}
