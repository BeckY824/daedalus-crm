param([string]$Installer)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:OS -ne 'Windows_NT') {
  throw 'This test creates an ordinary Windows user and is allowed only on a disposable GitHub Actions runner.'
}
if (!$Installer) {
  $packages = @(Get-ChildItem (Join-Path $PSScriptRoot '..\dist\*-x64-setup.exe'))
  if ($packages.Count -ne 1) { throw 'Expected exactly one candidate NSIS installer' }
  $Installer = $packages[0].FullName
}
$Installer = (Resolve-Path $Installer).Path
$id = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$name = "CrmG2_$id"
$root = Join-Path $env:PUBLIC "Documents\DaedalusCRM-G2-$id"
$blocked = Join-Path $env:ProgramFiles "DaedalusCRM-G2-$id"
$resultFile = Join-Path $root 'result.json'
$created = $false
try {
  $password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'aA!19') -AsPlainText -Force
  New-LocalUser -Name $name -Password $password -AccountExpires (Get-Date).AddDays(1) | Out-Null
  $created = $true
  $user = Get-LocalUser $name
  Add-LocalGroupMember -Group (Get-LocalGroup -SID 'S-1-5-32-545').Name -Member $name
  New-Item -ItemType Directory -Path $root, $blocked | Out-Null
  $acl = Get-Acl $root
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
  Set-Acl $root $acl
  $acl = Get-Acl $blocked
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($user.SID, 'Write', 'ContainerInherit,ObjectInherit', 'None', 'Deny'))
  Set-Acl $blocked $acl
  $copy = Join-Path $root 'setup.exe'
  Copy-Item $Installer $copy
  $normal = Join-Path $root '普通 安装\Daedalus CRM'
  $child = Join-Path $root 'check.ps1'
  @'
param($Installer, $Normal, $Blocked, $ResultFile)
$ErrorActionPreference = 'Stop'
try {
  $first = Start-Process $Installer -ArgumentList ("/S /currentuser /D=" + $Normal) -Wait -PassThru
  if ($first.ExitCode -ne 0) { throw "Baseline install failed: $($first.ExitCode)" }
  $exe = Join-Path $Normal 'Daedalus CRM.exe'
  if (!(Test-Path $exe)) { throw 'Baseline exe missing' }
  $hash = (Get-FileHash $exe -Algorithm SHA256).Hash
  $keys = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object { $_.InstallLocation -eq $Normal })
  if ($keys.Count -ne 1) { throw 'Baseline uninstall registration missing or ambiguous' }
  $key = $keys[0].PSPath
  function Registration { Get-ItemProperty $key | Select-Object InstallLocation, UninstallString, QuietUninstallString, DisplayVersion | ConvertTo-Json -Compress }
  function Shortcuts {
    @(Get-ChildItem ([Environment]::GetFolderPath('Desktop')), ([Environment]::GetFolderPath('Programs')) -Recurse -Filter 'Daedalus CRM.lnk' -ErrorAction SilentlyContinue |
      Sort-Object FullName | ForEach-Object { @{ path=$_.FullName; sha256=(Get-FileHash $_.FullName -Algorithm SHA256).Hash } }) | ConvertTo-Json -Compress
  }
  $before = Registration
  $links = Shortcuts
  $second = Start-Process $Installer -ArgumentList ("/S /currentuser /D=" + $Blocked) -Wait -PassThru
  if ($second.ExitCode -eq 0) { throw 'Unwritable installation incorrectly returned success' }
  if (!(Test-Path $exe)) { throw 'Failed installation removed the previously usable exe' }
  if ((Get-FileHash $exe -Algorithm SHA256).Hash -ne $hash) { throw 'Failed installation changed old exe' }
  if ((Registration) -ne $before) { throw 'Failed installation changed uninstall registration' }
  if ((Shortcuts) -ne $links) { throw 'Failed installation changed old shortcuts' }
  if (Test-Path (Join-Path $Blocked 'Daedalus CRM.exe')) { throw 'Protected target unexpectedly has exe' }
  @{ok=$true; baselineExitCode=$first.ExitCode; deniedExitCode=$second.ExitCode; oldExeUnchanged=$true; registrationUnchanged=$true; shortcutsUnchanged=$true} | ConvertTo-Json | Set-Content $ResultFile -Encoding UTF8
  exit 0
} catch {
  @{ok=$false; error=$_.Exception.Message} | ConvertTo-Json | Set-Content $ResultFile -Encoding UTF8
  exit 1
}
'@ | Set-Content $child -Encoding UTF8
  Start-Service seclogon
  $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
  $arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$child`"", '-Installer', "`"$copy`"", '-Normal', "`"$normal`"", '-Blocked', "`"$blocked`"", '-ResultFile', "`"$resultFile`"")
  $process = Start-Process powershell.exe -Credential $credential -LoadUserProfile -WorkingDirectory $root -ArgumentList $arguments -Wait -PassThru
  if (!(Test-Path $resultFile)) { throw "Ordinary-user test did not create evidence (exit $($process.ExitCode))" }
  $result = Get-Content $resultFile -Raw | ConvertFrom-Json
  Get-Content $resultFile -Raw | Write-Output
  Copy-Item $resultFile (Join-Path $PSScriptRoot '..\dist\windows-permission-result.json')
  if ($process.ExitCode -ne 0 -or !$result.ok) { throw 'Windows installation permission regression failed' }
} finally {
  if ($created) { Remove-LocalUser -Name $name }
  if (Test-Path $blocked) { Remove-Item $blocked -Recurse -Force }
}
