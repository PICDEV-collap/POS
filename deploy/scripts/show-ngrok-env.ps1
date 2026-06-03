# Print ngrok HTTPS URL and suggested backend .env lines.
# Run while ngrok is up (local API :4040).

$ErrorActionPreference = 'Stop'

try {
  $tunnels = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 3
} catch {
  Write-Host 'ngrok local API not reachable on :4040 — is the tunnel running?'
  exit 1
}

$url = $tunnels.tunnels |
  Where-Object { $_.public_url -like 'https://*' } |
  Select-Object -First 1 -ExpandProperty public_url

if (-not $url) {
  Write-Host 'No HTTPS tunnel found yet.'
  exit 1
}

$tunnelHost = ([Uri]$url).Host

Write-Host ""
Write-Host "ngrok public URL: $url"
Write-Host ""
Write-Host "Add or update in backend/.env:"
Write-Host "PUBLIC_BASE_URL=$url"
Write-Host "ADMIN_CONTROL_TUNNEL_HOSTS=$tunnelHost"
Write-Host ""
Write-Host "Then restart backend:"
Write-Host "  D:\POS_V2\deploy\services\pos-v2-backend.exe restart"
