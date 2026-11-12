# 上传 DSH Release 资产，完全不依赖 bash。
# 由任务计划程序启动，属于独立进程，不会随会话执行器故障终止。
$ErrorActionPreference = 'Continue'
$Out   = 'C:\Users\DR\Downloads\DSH\dsh-pack-rust\_build\out'
$Repo  = 'DRDRDRRDDRDR/dsh-pack-installer'
$RelId = '442836525'
$Log   = 'C:\Users\DR\Downloads\DSH\dsh-pack-rust\_upload.log'
$Curl  = 'C:\Windows\System32\curl.exe'

function Log($m) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $m"
  Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
}

# 从 git 凭据管理器取 token
$token = $null
$GitExe = 'C:\Program Files\Git\cmd\git.exe'
if (Test-Path -LiteralPath $GitExe) {
  $ask = "protocol=https`nhost=github.com`n`n"
  $ask | & $GitExe credential fill 2>$null | ForEach-Object {
    if ($_ -like 'password=*') { $token = $_.Substring(9) }
  }
}

if (-not $token) { Log 'NO_TOKEN'; exit 1 }
Log "token acquired length=$($token.Length)"

$files = @(
  'payload.tar.001', 'payload.tar.002', 'payload.tar.003', 'payload.tar.004',
  'dsh-pack-installer.exe', 'manifest.json', 'volumes.json'
)

$failed = 0
foreach ($name in $files) {
  $path = Join-Path $Out $name
  if (-not (Test-Path -LiteralPath $path)) { Log "skip missing $name"; continue }
  $size = (Get-Item -LiteralPath $path).Length
  Log "start $name bytes=$size"
  $url = "https://uploads.github.com/repos/$Repo/releases/$RelId/assets?name=$name"
  $resp = Join-Path $env:TEMP "up-$name.json"
  $code = & $Curl -s -o $resp -w '%{http_code}' -X POST `
    -H "Authorization: token $token" `
    -H 'Content-Type: application/octet-stream' `
    --data-binary "@$path" $url --max-time 7200
  Log "$name code=$code"
  if ($code -ne '201') {
    try { Log ("resp=" + (Get-Content -LiteralPath $resp -Raw -ErrorAction SilentlyContinue).Substring(0, [Math]::Min(300, (Get-Content -LiteralPath $resp -Raw -ErrorAction SilentlyContinue).Length))) } catch {}
    $failed++
  }
}

Log "UPLOAD_RESULT failed=$failed"
