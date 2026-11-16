# POC 開服：遊戲伺服器 + Cloudflare Tunnel 一起啟動，Ctrl+C 一起結束（見 docs/DEPLOY.md「POC」）。
# 用法：powershell -File deploy\serve-poc.ps1
# 埠號要與 ~/.cloudflared/temple.yml 的 service 一致。
$ErrorActionPreference = 'Stop'
$env:PORT = '8081'
$env:ALLOWED_ORIGINS = 'https://temple.wishly.tw'

$tunnel = Start-Process cloudflared -NoNewWindow -PassThru -ArgumentList @(
    'tunnel', '--config', "`"$env:USERPROFILE\.cloudflared\temple.yml`"", 'run')
try {
    cargo run --release --locked --bin temple-server --manifest-path "$PSScriptRoot\..\server\Cargo.toml"
} finally {
    if (-not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id }
}
