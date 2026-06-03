# Restrict POS app ports to Private/Domain profile only (ngrok tunnels to localhost).
# Run as Administrator. Complements firewall-allow.ps1 — run this on production with ngrok.

$ErrorActionPreference = 'Stop'

$rules = @(
  @{ Name = 'POS_V2 Backend (4000)'; Port = 4000 },
  @{ Name = 'POS_V2 Web (3000)'; Port = 3000 }
)

foreach ($r in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Remove-NetFirewallRule -DisplayName $r.Name
    Write-Host "Removed old rule: $($r.Name)" -ForegroundColor Yellow
  }
  New-NetFirewallRule `
    -DisplayName $r.Name `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $r.Port `
    -Profile Private,Domain | Out-Null
  Write-Host "LAN-only allow: $($r.Name) tcp/$($r.Port) (Private,Domain)" -ForegroundColor Green
}

Write-Host ""
Write-Host "Ports 3000/4000 are NOT open on Public profile."
Write-Host "Internet access should go through ngrok -> localhost:3000 only."
