# Download the DSH documentation corpus into a local, greppable mirror.
#
# Why: the manual is ~90 site pages PLUS repo-only documents (docs/testing.zh.md,
# .agents/skills/*) that never appear on the site and are exactly the ones that
# decided the hardest问题 in this repository. A mirror makes every lookup local,
# offline and cheap, so consulting the docs stops competing with context budget.
#
# Layout:  <cache>/site/<section>__<page>.txt   plain text, one file per page
#          <cache>/repo/<path>.md              repository documents, verbatim
#          <cache>/INDEX.md                    task -> page routing table
param(
  [string]$Cache = "$env:USERPROFILE\.dsh\dsh-manual"
)

$ErrorActionPreference = 'Stop'
$siteDir = Join-Path $Cache 'site'
$repoDir = Join-Path $Cache 'repo'
New-Item -ItemType Directory -Path $siteDir, $repoDir -Force | Out-Null

function Convert-HtmlToText([string]$html) {
  $text = $html -replace '(?s)<script.*?</script>', ' '
  $text = $text -replace '(?s)<style.*?</style>', ' '
  $text = $text -replace '(?s)<nav.*?</nav>', ' '
  $text = $text -replace '(?s)<head.*?</head>', ' '
  $text = $text -replace '<[^>]+>', ' '
  $text = $text -replace '&nbsp;', ' ' -replace '&amp;', '&' -replace '&lt;', '<' -replace '&gt;', '>' -replace '&quot;', '"' -replace '&#39;', "'"
  $text = $text -replace '[ \t]+', ' '
  $text = $text -replace '(\r?\n\s*){3,}', "`n`n"
  return $text.Trim()
}

$urls = Get-Content (Join-Path $Cache '_urls.txt') | Where-Object { $_ -match '/develop/|/reference/' }
Write-Host "站点页面: $($urls.Count)"
$ok = 0; $skip = 0; $fail = 0
foreach ($u in $urls) {
  $slug = ($u -replace '^/deepseek-harness/', '') -replace '/$', ''
  if ([string]::IsNullOrWhiteSpace($slug)) { $slug = 'index' }
  $slug = $slug -replace '/', '__'
  $out = Join-Path $siteDir "$slug.txt"
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 2000)) { $skip++; continue }
  $raw = Join-Path $env:TEMP "dsh-doc-dl.html"
  & curl.exe -s -L --max-time 40 -o $raw "https://deepseek-harness.github.io$u" 2>$null
  if (-not (Test-Path $raw)) { $fail++; continue }
  $html = Get-Content $raw -Raw
  if ([string]::IsNullOrWhiteSpace($html)) { $fail++; continue }
  Convert-HtmlToText $html | Set-Content $out -Encoding utf8
  $ok++
}
Write-Host "  抓取 $ok / 跳过 $skip / 失败 $fail"
Remove-Item (Join-Path $env:TEMP 'dsh-doc-dl.html') -Force -ErrorAction SilentlyContinue

# Repository documents that are NOT on the site. These are the ones the site's
# own pages point at as authoritative (the testing policy, the architecture map,
# the CI reliability skill).
$repoDocs = @(
  'docs/testing.zh.md',
  'docs/architecture.zh.md',
  'docs/development.zh.md',
  'docs/event-producer-consumer.zh.md',
  'docs/cookbook/adding-a-package.zh.md',
  'docs/cookbook/adding-a-tool.zh.md',
  'docs/cookbook/adding-an-llm-adapter.zh.md',
  'docs/cookbook/adding-a-settings-card.zh.md',
  'docs/cookbook/extension-cookbook.zh.md',
  'docs/cookbook/adding-a-session-format-version.zh.md',
  'docs/session-format-status.zh.md',
  'AGENTS.md',
  '.agents/skills/dsh-ci-test-reliability/SKILL.md',
  '.agents/skills/dsh-ci-test-reliability/references/ci-flake-diagnosis.md',
  '.agents/skills/dsh-doc/SKILL.md',
  '.agents/skills/dsh-prose-standard/SKILL.md',
  '.agents/skills/dsh-doc/references/metadata-links-i18n.md'
)
Write-Host "仓库文档: $($repoDocs.Count)"
$rok = 0; $rfail = @()
foreach ($p in $repoDocs) {
  $out = Join-Path $repoDir ($p -replace '/', '__')
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 500)) { $rok++; continue }
  $url = "https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/$p"
  & curl.exe -s -L -f --max-time 40 -o $out $url 2>$null
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 200)) { $rok++ } else { $rfail += $p; Remove-Item $out -Force -ErrorAction SilentlyContinue }
}
Write-Host "  取到 $rok / 失败 $($rfail.Count)"
$rfail | ForEach-Object { "    缺失: $_" }

Write-Host ""
Write-Host "镜像统计:"
Write-Host "  site: $((Get-ChildItem $siteDir -File).Count) 个文件"
Write-Host "  repo: $((Get-ChildItem $repoDir -File).Count) 个文件"
