# Open the ports POS_V2 needs on Windows Defender Firewall.
# Run as Administrator.

$rules = @(
  @{ Name = "POS_V2 Backend (4000)"; Port = 4000 },
  @{ Name = "POS_V2 Web (3000)";     Port = 3000 },
  @{ Name = "POS_V2 HTTPS (443)";    Port = 443  },
  @{ Name = "POS_V2 HTTP (80)";      Port = 80   }
)

foreach ($r in $rules) {
  $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Skipping (already exists): $($r.Name)" -ForegroundColor Yellow
    continue
  }
  New-NetFirewallRule `
    -DisplayName $r.Name `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $r.Port `
    -Profile Private,Domain | Out-Null
  Write-Host "Allowed: $($r.Name) tcp/$($r.Port)" -ForegroundColor Green
}

# mDNS advertisement uses UDP 5353 — most installs already allow this for "Network Discovery".
$mdnsRule = "POS_V2 mDNS (5353/udp)"
if (-not (Get-NetFirewallRule -DisplayName $mdnsRule -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule `
    -DisplayName $mdnsRule `
    -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5353 `
    -Profile Private,Domain | Out-Null
  Write-Host "Allowed: $mdnsRule" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Verify with: Get-NetFirewallRule -DisplayName 'POS_V2*' | Format-Table"
