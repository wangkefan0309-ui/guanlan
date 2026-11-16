param([ValidateSet('setup', 'start', 'status', 'stop')][string]$Action = 'status')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $projectRoot '.local/rsshub'
$configPath = Join-Path $runtimeDir 'config.json'
$commit = 'acdbec61c4977a7d9ab458c455365237e15e3d42'
if ($Action -eq 'setup') {
    # Adopt the already verified local installation, without editing third-party code.
    $testedDir = Join-Path $projectRoot '.local/bilibili-free/rsshub-test'
    $upstream = Join-Path $testedDir 'upstream'
    $node = Join-Path $testedDir 'node-runtime/node-v22.22.2-win-x64/node.exe'
    $chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
    foreach ($path in @($node, $chrome, (Join-Path $upstream 'node_modules/rsshub/package.json'))) {
        if (-not (Test-Path -LiteralPath $path)) { throw '缺少已验证的 RSSHub 运行依赖；请按 docs/rsshub-runtime.md 安装后重试。' }
    }
    $actualCommit = (& git -C $upstream rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $commit) { throw 'RSSHub 源码版本与本机验收版本不一致。' }
    $dependency = Get-Content -LiteralPath (Join-Path $upstream 'node_modules/rsshub/package.json') -Raw | ConvertFrom-Json
    if ($dependency.version -ne '1.0.0-master.5d857e3') { throw 'RSSHub 依赖环境版本与验收版本不一致。' }
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    if (Test-Path -LiteralPath $configPath) { throw 'RSSHub 已配置；请使用 start/status/stop，避免覆盖已有配置。' }
    $config = @{ port = 1200; upstream = $upstream; node = $node; chrome = $chrome; commit = $commit; dependencyVersion = $dependency.version; reuseHttpsProxy = $true }
    $config | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding utf8
    $controlBytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($controlBytes)
    [Convert]::ToBase64String($controlBytes) | Set-Content -LiteralPath (Join-Path $runtimeDir 'control-token.txt') -Encoding utf8
    Write-Output 'RSSHub 本机配置已保存。'
    exit 0
}
if (-not (Test-Path -LiteralPath $configPath)) { throw 'RSSHub 尚未配置，请先运行 npm run rsshub:setup。' }
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$baseUrl = 'http://127.0.0.1:' + $settings.port
$controlToken = (Get-Content -LiteralPath (Join-Path $runtimeDir 'control-token.txt') -Raw).Trim()
$headers = @{ Authorization = 'Bearer ' + $controlToken }
function Read-Runtime {
    try { Invoke-RestMethod -Uri ($baseUrl + '/_workbench/rsshub') -Headers $headers -TimeoutSec 2 }
    catch { $null }
}
$live = Read-Runtime
if ($Action -eq 'status') {
    if ($null -eq $live) { Write-Output 'RSSHub 当前未运行或管理校验失败。'; exit 1 }
    $live | ConvertTo-Json
    exit 0
}
if ($Action -eq 'stop') {
    if ($null -eq $live) { throw '没有可校验的本项目 RSSHub 实例；不会按端口或 PID 停止其他进程。' }
    Invoke-RestMethod -Uri ($baseUrl + '/_workbench/rsshub/stop') -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 3 | Out-Null
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ($null -eq (Read-Runtime)) { Write-Output '本项目 RSSHub 已正常停止。'; exit 0 }
    }
    throw '停止请求已发送，进程仍在结束当前请求；请稍后检查 status。'
}
if ($null -ne $live) { Write-Output 'RSSHub 已在运行。'; exit 0 }
if (Get-NetTCPConnection -State Listen -LocalPort $settings.port -ErrorAction SilentlyContinue) { throw 'RSSHub 端口已被其他进程占用，请检查本机配置；不会停止占用进程。' }
$runner = Join-Path $projectRoot 'node_modules/tsx/dist/cli.mjs'
$boot = Join-Path $PSScriptRoot 'rsshub-runtime.mjs'
$tsconfig = Join-Path $settings.upstream 'tsconfig.json'
$arguments = '"' + $runner + '" --tsconfig "' + $tsconfig + '" "' + $boot + '" "' + $configPath + '"'
Start-Process -FilePath $settings.node -ArgumentList $arguments -WorkingDirectory $settings.upstream -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeDir 'stdout.log') -RedirectStandardError (Join-Path $runtimeDir 'stderr.log') | Out-Null
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ($null -ne (Read-Runtime)) { Write-Output ('RSSHub 已启动：' + $baseUrl); exit 0 }
}
throw 'RSSHub 启动未通过管理校验，请查看 .local/rsshub/stderr.log。'
