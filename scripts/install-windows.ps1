#requires -Version 5.1
# Run as Administrator under the Windows account that runs Docker Desktop.
param(
 [string]$AgentBinary,
 [string]$ControlPlane = 'https://fleetapi.plastikworld.xyz',
 [string]$Token,
 [PSCredential]$ServiceCredential
)
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
 throw 'Open PowerShell as Administrator using the same Windows account as Docker Desktop.'
}
$uri = [uri]$ControlPlane
if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) { throw 'Use an HTTPS control-plane URL without credentials, query or fragment.' }
$ControlPlane = $ControlPlane.TrimEnd('/')
$architecture = $env:PROCESSOR_ARCHITEW6432
if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
if ($architecture -ne 'AMD64') { throw 'Only Windows amd64 is currently packaged. Windows ARM64 installation is not verified.' }
$dockerPath = (Get-Command docker.exe -ErrorAction SilentlyContinue).Source
if (-not $dockerPath) { $dockerPath = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe' }
if (-not (Test-Path $dockerPath)) { throw 'Install and start Docker Desktop with Linux containers, then retry.' }
$infoText = & $dockerPath info --format '{{json .}}' 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop is not responding. Start it under this Windows account and retry.' }
$info = $infoText | ConvertFrom-Json
if ($info.OSType -ne 'linux') { throw 'Switch Docker Desktop to Linux containers' }
Write-Host ('Docker engine detected: linux/{0}' -f $info.Architecture)
$root = Join-Path $env:ProgramData 'FleetOS'
$legacyState = Join-Path $env:USERPROFILE '.fleet-os\agent.json'
if ((Test-Path $legacyState) -and -not (Test-Path (Join-Path $root 'agent.json'))) {
 throw 'An existing Git Bash node identity was found in your .fleet-os directory. Follow docs/cli-experience.md to migrate it without re-pairing; no files have been replaced.'
}
$destination = Join-Path $root 'fleet-agent.exe'
$state = Join-Path $root 'agent.json'
$backup = "$destination.previous.exe"
$existing = Get-Service FleetAgent -ErrorAction SilentlyContinue
$original = Get-CimInstance Win32_Service -Filter "Name='FleetAgent'" -ErrorAction SilentlyContinue
$wasRunning = $existing -and $existing.Status -eq 'Running'
$hasState = Test-Path $state
if ($hasState) {
 $saved = Get-Content $state -Raw | ConvertFrom-Json
 if ($saved.control_plane_url.TrimEnd('/') -ne $ControlPlane) { throw 'This node belongs to another control plane. Deliberately unpair it before changing identity.' }
 Write-Host 'Preserving existing identity; no pairing token will be consumed.'
} elseif (-not $Token) { throw 'Generate a token with fleet nodes pair --target windows.' }
if ($original) {
 $account = New-Object Security.Principal.NTAccount($original.StartName)
} else {
 if (-not $ServiceCredential) { $ServiceCredential = Get-Credential -UserName $identity.Name -Message 'Windows account password (not PIN), for the FleetAgent service logon.' }
 if (-not $ServiceCredential) { throw 'Service setup cancelled.' }
 $account = New-Object Security.Principal.NTAccount($ServiceCredential.UserName)
}
if ($account.Translate([Security.Principal.SecurityIdentifier]).Value -ne $identity.User.Value) { throw 'The service must run under the current Docker Desktop account.' }
New-Item -ItemType Directory -Force -Path $root | Out-Null
& icacls.exe $root /inheritance:r /grant:r '*S-1-5-32-544:(OI)(CI)F' ('*{0}:(OI)(CI)F' -f $identity.User.Value) /T | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not restrict the FleetOS directory permissions.' }
$temporary = Join-Path $root ('.install-' + [guid]::NewGuid().ToString())
$oldToken = $env:FLEET_PAIRING_TOKEN
$replaced = $false
$created = $false
$hadBinary = Test-Path $destination
$phase = 'checksum verification'
try {
 New-Item -ItemType Directory -Path $temporary | Out-Null
 [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
 $name = 'fleet-agent-windows-amd64.exe'
 $download = Join-Path $temporary $name
 $sums = (Invoke-WebRequest -UseBasicParsing "$ControlPlane/install/SHA256SUMS").Content
 $entries = @($sums -split "`n" | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+\*?' + [regex]::Escape($name) + '\s*$') })
 if ($entries.Count -ne 1) { throw 'No unique checksum published for this Windows binary. Installation refused.' }
 $expected = ($entries[0] -split '\s+')[0]
 if ($AgentBinary) { Copy-Item (Resolve-Path $AgentBinary) $download } else { Invoke-WebRequest -UseBasicParsing "$ControlPlane/install/$name" -OutFile $download }
 if ((Get-FileHash $download -Algorithm SHA256).Hash -ne $expected) { throw 'Agent checksum mismatch. Nothing was installed.' }
 Write-Host 'Agent checksum verified.'
 $phase = 'stopping the previous service and backing up its binary'
 if ($existing) {
  Stop-Service FleetAgent
  (Get-Service FleetAgent).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
 }
 if ($hadBinary) { Copy-Item $destination $backup -Force }
 $replaced = $true
 Copy-Item $download $destination -Force
 if (-not $hasState) {
  $phase = 'registration (check Docker and pairing-token expiry)'
  $env:FLEET_PAIRING_TOKEN = $Token
  & $destination --state $state --control-plane $ControlPlane --register-only
  if ($LASTEXITCODE -ne 0) { throw 'Registration failed. Check Docker and pairing-token expiry.' }
 }
 $env:FLEET_PAIRING_TOKEN = $oldToken
 $Token = $null
 $phase = 'Windows service configuration (check service-account logon rights)'
 $command = '"{0}" --state "{1}" --control-plane "{2}"' -f $destination,$state,$ControlPlane
 if ($existing) {
  & sc.exe config FleetAgent binPath= $command start= auto | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not configure FleetAgent.' }
 } else {
  New-Service -Name FleetAgent -BinaryPathName $command -DisplayName 'Fleet OS Agent' -StartupType Automatic -Credential $ServiceCredential | Out-Null
  $created = $true
 }
 & sc.exe failure FleetAgent reset= 86400 actions= restart/60000/restart/60000/restart/60000 | Out-Null
 if ($LASTEXITCODE -ne 0) { throw 'Could not configure service recovery.' }
 Start-Service FleetAgent
 $phase = 'Windows service startup (check Docker Desktop access)'
 (Get-Service FleetAgent).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
 Start-Sleep -Seconds 3
 if ((Get-Service FleetAgent).Status -ne 'Running') { throw 'Agent stopped after startup. Check service logon and Docker Desktop access.' }
 Write-Host 'Agent installed. Windows service is running.'
 Write-Host 'The originating CLI confirms the first heartbeat. Alternatively run fleet nodes and fleet doctor.'
 if (Test-Path $backup) { Write-Host "Previous binary: $backup" }
} catch {
 if ($replaced) {
  Stop-Service FleetAgent -ErrorAction SilentlyContinue
  if ($created) { & sc.exe delete FleetAgent | Out-Null }
  if ($hadBinary -and (Test-Path $backup)) { Copy-Item $backup $destination -Force }
  elseif (-not $existing) { Remove-Item $destination -ErrorAction SilentlyContinue }
  if ($original) {
   $startMode = switch ($original.StartMode) { 'Auto' { 'auto' }; 'Disabled' { 'disabled' }; default { 'demand' } }
   & sc.exe config FleetAgent binPath= $original.PathName start= $startMode | Out-Null
  }
 }
 if ($wasRunning) { Start-Service FleetAgent -ErrorAction SilentlyContinue }
 # Do not dump invocation arguments, which include the single-use token.
 throw "Installation failed during $phase; previous binary/service restored where available. Node identity was preserved. Correct the issue and retry."
} finally {
 $env:FLEET_PAIRING_TOKEN = $oldToken
 $Token = $null
 Remove-Item $temporary -Recurse -Force -ErrorAction SilentlyContinue
}
