#!/usr/bin/env bash
# Sets PatchLab up on Google Cloud Run: the bucket for users' labs, the service account it
# runs as, IAP access, and (optionally) the build and deploy. Safe to run again: anything
# that already exists is kept.
#
# Usage:  ./scripts/setup.sh            run it
#         DRY_RUN=1 ./scripts/setup.sh  print the gcloud commands without running them
#
# Defaults come from deploy/config.env, then deploy/config.local.env (your last answers).
set -euo pipefail

cd "$(dirname "$0")/.."
KEYS="ACCOUNT PROJECT_ID REGION SERVICE BUCKET SERVICE_ACCOUNT IAP_USERS MEMORY MIN_INSTANCES MAX_INSTANCES CONCURRENCY"
LOCAL=deploy/config.local.env

# Reads KEY=value lines; comments and blank lines are skipped. Nothing in the file is executed.
load() {
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    case " $KEYS " in *" $key "*) printf -v "$key" '%s' "$val" ;; esac
  done < "$1"
}

for k in $KEYS; do printf -v "$k" '%s' ''; done
load deploy/config.env
load "$LOCAL"

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud is not installed or not on PATH. Install the Google Cloud CLI first:"
  echo "  https://cloud.google.com/sdk/docs/install"
  exit 1
fi

run() {
  echo "+ $*"
  if [ -z "${DRY_RUN:-}" ]; then "$@"; fi
}

ask() {
  local key="$1" label="$2" def="$3" answer
  read -r -p "$label [$def]: " answer || true
  printf -v "$key" '%s' "${answer:-$def}"
}

echo "PatchLab setup. Press Enter to keep each value in brackets, or type another."
echo
[ -n "$ACCOUNT" ] || ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
ask ACCOUNT "Google account to run gcloud as" "$ACCOUNT"
[ -n "$PROJECT_ID" ] || PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
ask PROJECT_ID "Google Cloud project ID" "$PROJECT_ID"
[ -n "$PROJECT_ID" ] || { echo "A project ID is required."; exit 1; }
ask REGION "Region" "$REGION"
ask SERVICE "Cloud Run service name" "$SERVICE"
[ -n "$BUCKET" ] || BUCKET="${PROJECT_ID}-patchlab-labs"
ask BUCKET "Bucket for users' labs" "$BUCKET"
ask SERVICE_ACCOUNT "Service account name" "$SERVICE_ACCOUNT"
ask IAP_USERS "Who may sign in (comma-separated emails)" "$IAP_USERS"
ask MEMORY "Memory" "$MEMORY"
ask MIN_INSTANCES "Minimum instances" "$MIN_INSTANCES"
ask MAX_INSTANCES "Maximum instances" "$MAX_INSTANCES"
ask CONCURRENCY "Requests per instance" "$CONCURRENCY"

SA_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"
echo
echo "Account          $ACCOUNT"
echo "Project          $PROJECT_ID ($REGION)"
echo "Service          $SERVICE, runs as $SA_EMAIL"
echo "Bucket           gs://$BUCKET"
echo "Sign-in allowed  ${IAP_USERS:-(nobody yet)}"
echo "Limits           $MEMORY, $MIN_INSTANCES to $MAX_INSTANCES instances, $CONCURRENCY requests each"
read -r -p "Go ahead? [y/N]: " go || true
case "$go" in y|Y|yes|YES) ;; *) echo "Nothing changed."; exit 0 ;; esac

{
  echo "# Your answers from scripts/setup.sh. Not committed; delete to go back to deploy/config.env."
  for k in $KEYS; do echo "$k=${!k}"; done
} > "$LOCAL"
echo "Saved your answers to $LOCAL."
echo

# Every gcloud call names the account and project, so the active gcloud settings do not matter.
export CLOUDSDK_CORE_ACCOUNT="$ACCOUNT"
P="--project=$PROJECT_ID"
echo "== Turning on the APIs PatchLab needs"
run gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iap.googleapis.com storage.googleapis.com "$P"

echo "== Bucket"
if [ -z "${DRY_RUN:-}" ] && gcloud storage buckets describe "gs://$BUCKET" "$P" >/dev/null 2>&1; then
  echo "gs://$BUCKET already exists; keeping it."
else
  run gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access --public-access-prevention "$P"
fi

echo "== Service account"
if [ -z "${DRY_RUN:-}" ] && gcloud iam service-accounts describe "$SA_EMAIL" "$P" >/dev/null 2>&1; then
  echo "$SA_EMAIL already exists; keeping it."
else
  run gcloud iam service-accounts create "$SERVICE_ACCOUNT" --display-name="PatchLab on Cloud Run" "$P"
fi
run gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA_EMAIL" --role=roles/storage.objectUser "$P"

echo
read -r -p "Build and deploy to Cloud Run now? [Y/n]: " dep || true
case "$dep" in n|N|no|NO)
  echo "Skipped. Deploy later by running this script again."
  exit 0 ;;
esac

echo "== Build"
if command -v node >/dev/null 2>&1; then
  run node scripts/bundle.js
elif [ -f dist/patchlab.html ]; then
  echo "Node.js not found; deploying the existing dist/patchlab.html."
else
  echo "Node.js is needed to build dist/patchlab.html: https://nodejs.org"
  exit 1
fi

echo "== Deploy"
NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || echo PROJECT_NUMBER)"
run gcloud run deploy "$SERVICE" --source . --region "$REGION" --iap --no-allow-unauthenticated \
  --service-account "$SA_EMAIL" \
  --set-env-vars "BUCKET=$BUCKET,IAP_AUDIENCE=/projects/$NUMBER/locations/$REGION/services/$SERVICE" \
  --memory "$MEMORY" --min-instances "$MIN_INSTANCES" --max-instances "$MAX_INSTANCES" --concurrency "$CONCURRENCY" --quiet "$P"

echo "== Sign-in access"
IFS=',' read -r -a users <<< "$IAP_USERS"
for u in "${users[@]:-}"; do
  u="$(echo "$u" | tr -d '[:space:]')"
  [ -n "$u" ] || continue
  case "$u" in *:*) member="$u" ;; *) member="user:$u" ;; esac
  # One refused address (an organization policy, say) should not stop the others.
  run gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service="$SERVICE" --region="$REGION" \
    --member="$member" --role=roles/iap.httpsResourceAccessor --condition=None "$P" >/dev/null \
    || echo "   Could not give $u access. See the message above."
done
echo "Accounts outside your organization (gmail.com, for example) also need the OAuth consent"
echo "screen set to External; see 'Letting people outside your organization sign in' in the README."

echo
if [ -z "${DRY_RUN:-}" ]; then
  echo "Done. PatchLab is at: $(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)' "$P")"
else
  echo "Dry run: nothing was changed."
fi
