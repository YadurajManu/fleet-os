# Run in an elevated PowerShell. Use the Windows account that runs Docker Desktop.
# This registers a locally supplied, verified binary; it downloads nothing.
param(
 [Parameter(Mandatory=$true)][string]$AgentBinary,
 [string]$ControlPlane = 'https://fleetapi.plastikworld.xyz',
 [Parameter(Mandatory=$true)][PSCredential]$ServiceCredential
)
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:ProgramData 'FleetOS'
New-Item -ItemType Directory -Force -Path $root | Out-Null
$destination = Join-Path $root 'fleet-agent.exe'
if (Get-Service FleetAgent -ErrorAction SilentlyContinue) {
 Stop-Service FleetAgent
 (Get-Service FleetAgent).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
}
if (Test-Path $destination) { Copy-Item $destination "$destination.previous.exe" -Force }
Copy-Item (Resolve-Path $AgentBinary) $destination -Force
$state = Join-Path $root 'agent.json'
# Pair interactively first using --register-only. The single-use token is never
# embedded into the service's command line or its persistent configuration.
if (-not (Test-Path $state)) { throw "Pair first: run the agent with --state $state --control-plane $ControlPlane --register-only and a single-use pairing token." }
$command = '"{0}" --state "{1}" --control-plane "{2}"' -f $destination,$state,$ControlPlane
if (Get-Service FleetAgent -ErrorAction SilentlyContinue) {
 & sc.exe config FleetAgent binPath= $command | Out-Null
} else {
 New-Service -Name FleetAgent -BinaryPathName $command -DisplayName 'Fleet OS Agent' -StartupType Automatic -Credential $ServiceCredential | Out-Null
}
# Keep state and credentials private to Administrators and the service account.
& icacls.exe $root /inheritance:r /grant:r 'BUILTIN\Administrators:(OI)(CI)F' "$($ServiceCredential.UserName):(OI)(CI)F" /T | Out-Null
& sc.exe failure FleetAgent reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
& sc.exe failureflag FleetAgent 1 | Out-Null
Start-Service FleetAgent
