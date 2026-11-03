# Sets PatchLab up on Google Cloud Run from Windows PowerShell: the bucket for users' labs,
# the service account it runs as, IAP access, and (optionally) the build and deploy. Safe to
# run again: anything that already exists is kept. Same steps as scripts/setup.sh.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#         powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -DryRun
#
# Defaults come from deploy\config.env, then deploy\config.local.env (your last answers).
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$Keys = 'ACCOUNT', 'PROJECT_ID', 'REGION', 'SERVICE', 'BUCKET', 'SERVICE_ACCOUNT', 'IAP_USERS', 'MEMORY', 'MIN_INSTANCES', 'MAX_INSTANCES', 'CONCURRENCY'
$Local = 'deploy\config.local.env'
$C = @{}
foreach ($k in $Keys) { $C[$k] = '' }

# Reads KEY=value lines; comments and blank lines are skipped. Nothing in the file is executed.
function Load-Config($file) {
  if (-not (Test-Path $file)) { return }
  foreach ($line in Get-Content $file) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $key, $val = $line -split '=', 2
    if ($Keys -contains $key.Trim()) { $C[$key.Trim()] = $val.Trim() }
  }
}
Load-Config 'deploy\config.env'
Load-Config $Local

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  Write-Host 'gcloud is not installed or not on PATH. Install the Google Cloud CLI first:'
  Write-Host '  https://cloud.google.com/sdk/docs/install'
  exit 1
}

function Run {
  Write-Host "+ gcloud $($args -join ' ')"
  if (-not $DryRun) {
    & gcloud @args
    if ($LASTEXITCODE -ne 0) { throw "gcloud failed: $($args -join ' ')" }
  }
}

function Ask($key, $label) {
  $answer = Read-Host "$label [$($C[$key])]"
  if ($answer) { $C[$key] = $answer.Trim() }
}

function Gcloud-Value { $v = & gcloud @args 2>$null; if ($LASTEXITCODE -eq 0) { "$v".Trim() } else { '' } }

Write-Host 'PatchLab setup. Press Enter to keep each value in brackets, or type another.'
Write-Host ''
if (-not $C.ACCOUNT) { $C.ACCOUNT = Gcloud-Value config get-value account }
Ask 'ACCOUNT' 'Google account to run gcloud as'
if (-not $C.PROJECT_ID) { $C.PROJECT_ID = Gcloud-Value config get-value project }
Ask 'PROJECT_ID' 'Google Cloud project ID'
if (-not $C.PROJECT_ID) { Write-Host 'A project ID is required.'; exit 1 }
Ask 'REGION' 'Region'
Ask 'SERVICE' 'Cloud Run service name'
if (-not $C.BUCKET) { $C.BUCKET = "$($C.PROJECT_ID)-patchlab-labs" }
Ask 'BUCKET' "Bucket for users' labs"
Ask 'SERVICE_ACCOUNT' 'Service account name'
Ask 'IAP_USERS' 'Who may sign in (comma-separated emails)'
Ask 'MEMORY' 'Memory'
Ask 'MIN_INSTANCES' 'Minimum instances'
Ask 'MAX_INSTANCES' 'Maximum instances'
Ask 'CONCURRENCY' 'Requests per instance'

$SA = "$($C.SERVICE_ACCOUNT)@$($C.PROJECT_ID).iam.gserviceaccount.com"
Write-Host ''
Write-Host "Account          $($C.ACCOUNT)"
Write-Host "Project          $($C.PROJECT_ID) ($($C.REGION))"
Write-Host "Service          $($C.SERVICE), runs as $SA"
Write-Host "Bucket           gs://$($C.BUCKET)"
Write-Host "Sign-in allowed  $(if ($C.IAP_USERS) { $C.IAP_USERS } else { '(nobody yet)' })"
Write-Host "Limits           $($C.MEMORY), $($C.MIN_INSTANCES) to $($C.MAX_INSTANCES) instances, $($C.CONCURRENCY) requests each"
if ((Read-Host 'Go ahead? [y/N]') -notmatch '^(y|yes)$') { Write-Host 'Nothing changed.'; exit 0 }

$out = @('# Your answers from scripts/setup.ps1. Not committed; delete to go back to deploy/config.env.')
foreach ($k in $Keys) { $out += "$k=$($C[$k])" }
Set-Content -Path $Local -Value $out
Write-Host "Saved your answers to $Local."

# Every gcloud call names the account and project, so the active gcloud settings do not matter.
$env:CLOUDSDK_CORE_ACCOUNT = $C.ACCOUNT
$P = "--project=$($C.PROJECT_ID)"

Write-Host '== Turning on the APIs PatchLab needs'
Run services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iap.googleapis.com storage.googleapis.com $P

Write-Host '== Bucket'
& gcloud storage buckets describe "gs://$($C.BUCKET)" $P *> $null
if (-not $DryRun -and $LASTEXITCODE -eq 0) { Write-Host "gs://$($C.BUCKET) already exists; keeping it." }
else { Run storage buckets create "gs://$($C.BUCKET)" "--location=$($C.REGION)" --uniform-bucket-level-access --public-access-prevention $P }

Write-Host '== Service account'
& gcloud iam service-accounts describe $SA $P *> $null
if (-not $DryRun -and $LASTEXITCODE -eq 0) { Write-Host "$SA already exists; keeping it." }
else { Run iam service-accounts create $C.SERVICE_ACCOUNT '--display-name=PatchLab on Cloud Run' $P }
Run storage buckets add-iam-policy-binding "gs://$($C.BUCKET)" "--member=serviceAccount:$SA" --role=roles/storage.objectUser $P

if ((Read-Host 'Build and deploy to Cloud Run now? [Y/n]') -match '^(n|no)$') { Write-Host 'Skipped. Deploy later by running this script again.'; exit 0 }

Write-Host '== Build'
if (Get-Command node -ErrorAction SilentlyContinue) {
  Write-Host '+ node scripts/bundle.js'
  if (-not $DryRun) { node scripts/bundle.js }
} elseif (Test-Path 'dist\patchlab.html') { Write-Host 'Node.js not found; deploying the existing dist\patchlab.html.' }
else { Write-Host 'Node.js is needed to build dist\patchlab.html: https://nodejs.org'; exit 1 }

Write-Host '== Deploy'
$Number = Gcloud-Value projects describe $C.PROJECT_ID '--format=value(projectNumber)'
if (-not $Number) { $Number = 'PROJECT_NUMBER' }
Run run deploy $C.SERVICE --source . --region $C.REGION --iap --no-allow-unauthenticated `
  --service-account $SA `
  "--set-env-vars=BUCKET=$($C.BUCKET),IAP_AUDIENCE=/projects/$Number/locations/$($C.REGION)/services/$($C.SERVICE)" `
  --memory $C.MEMORY --min-instances $C.MIN_INSTANCES --max-instances $C.MAX_INSTANCES --concurrency $C.CONCURRENCY --quiet $P

Write-Host '== Sign-in access'
foreach ($u in ($C.IAP_USERS -split ',')) {
  $u = $u.Trim()
  if (-not $u) { continue }
  $member = if ($u -like '*:*') { $u } else { "user:$u" }
  # One refused address (an organization policy, say) should not stop the others.
  try { Run iap web add-iam-policy-binding --resource-type=cloud-run "--service=$($C.SERVICE)" "--region=$($C.REGION)" "--member=$member" --role=roles/iap.httpsResourceAccessor --condition=None $P }
  catch { Write-Host "   Could not give $u access. See the message above." }
}
Write-Host "Accounts outside your organization (gmail.com, for example) also need the OAuth consent"
Write-Host "screen set to External; see 'Letting people outside your organization sign in' in the README."

if ($DryRun) { Write-Host 'Dry run: nothing was changed.' }
else { Write-Host "Done. PatchLab is at: $(Gcloud-Value run services describe $C.SERVICE --region $C.REGION '--format=value(status.url)' $P)" }
