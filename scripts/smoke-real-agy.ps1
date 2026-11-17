<#
.SYNOPSIS
Reproducible Windows PowerShell smoke verification script for agy-zotero-bridge (v0.2.0).
Runs against an already-authenticated official agy CLI installation without modifying global settings.
#>
param(
  [string]$BridgeUrl = 'http://127.0.0.1:8765',
  [string]$AgyBin = "$env:USERPROFILE\.gemini\bin\agy.exe",
  [string]$ZoteroMcpUrl = 'http://127.0.0.1:23119/llm-for-zotero/mcp'
)

$ErrorActionPreference = 'Stop'

Write-Host '=== 1. Check real agy CLI installation ===' -ForegroundColor Cyan
& $AgyBin --version
& $AgyBin --output-format json models | Out-Host

Write-Host "`n=== 2. Probe bridge /healthz, /models, /efforts ===" -ForegroundColor Cyan
Invoke-RestMethod -Uri "$BridgeUrl/healthz" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "$BridgeUrl/models" | ConvertTo-Json -Depth 5
Invoke-RestMethod -Uri "$BridgeUrl/efforts" | ConvertTo-Json -Depth 5

Write-Host "`n=== 3. Smoke test POST /run-turn (plain text) ===" -ForegroundColor Cyan
$turn1 = @{
  conversationKey = 'smoke-win-1'
  scopeType = 'library'
  scopeId = 'smoke'
  userText = 'Reply with exactly: SMOKE_OK_1'
} | ConvertTo-Json
Invoke-WebRequest -Uri "$BridgeUrl/run-turn" -Method POST -ContentType 'application/json' -Body $turn1 |
  Select-Object -ExpandProperty Content

Write-Host "`n=== 4. Smoke test session resume ===" -ForegroundColor Cyan
$turn2 = @{
  conversationKey = 'smoke-win-1'
  scopeType = 'library'
  scopeId = 'smoke'
  userText = 'Repeat the exact token you replied with in the previous turn.'
} | ConvertTo-Json
Invoke-WebRequest -Uri "$BridgeUrl/run-turn" -Method POST -ContentType 'application/json' -Body $turn2 |
  Select-Object -ExpandProperty Content

Write-Host "`n=== 5. Smoke test POST /structured-completion (JSON Schema) ===" -ForegroundColor Cyan
$structReq = @{
  prompt = 'Return a JSON object with status="ok" and bridge="agy".'
  timeoutMs = 60000
  schema = @{
    type = 'object'
    properties = @{
      status = @{ type = 'string' }
      bridge = @{ type = 'string' }
    }
    required = @('status', 'bridge')
  }
} | ConvertTo-Json -Depth 6
Invoke-RestMethod -Uri "$BridgeUrl/structured-completion" -Method POST -ContentType 'application/json' -Body $structReq |
  ConvertTo-Json -Depth 5

Write-Host "`n=== 6. Smoke test Zotero MCP endpoint reachability (read-only) ===" -ForegroundColor Cyan
Invoke-RestMethod -Uri "$BridgeUrl/mcp-servers?probe=1" | ConvertTo-Json -Depth 5
