#!/usr/bin/env bash
#
# Prune old GHCR container images, keeping the newest N *builds*.
#
# Why the grouping is by time and not by tag or digest:
#
# One `docker buildx` push publishes more than one package version. In the
# registry this looks like:
#
#   1433233153 | 2026-10-23T07:49:44Z | sha256:ddaa8e13... | sha-70e9e70,latest,main
#   1433233116 | 2026-10-23T07:49:44Z | sha256:75acf533... |
#   1433233075 | 2026-10-23T07:49:43Z | sha256:525b2695... |
#
# The tagged manifest is the image people pull; the untagged entries are the
# attestation manifests buildx pushes alongside it. They share a build and a
# timestamp, but - critically - every one of them has a *different* digest. So:
#
#   - Grouping by tag only sees the one tagged entry per build and treats each
#     untagged attestation as its own build.
#   - Grouping by digest is worse: it never merges anything, because no two
#     versions ever share a digest.
#   - Counting versions ("keep the newest 5") kept barely one and a half builds
#     and could cut a build's tag set in half.
#
# Versions belonging to one build are created within a second or two of each
# other, while separate builds are minutes apart, so clustering on creation
# time groups a build's versions correctly. A build is therefore kept or
# dropped as a unit.
#
# Environment:
#   GH_TOKEN              required; needs read:packages and write:packages
#   PACKAGE_NAME          container package name, e.g. ui2
#   MIN_IMAGES_TO_KEEP    number of newest builds to keep (default 5)
#   GITHUB_REPOSITORY     owner/repo, provided by Actions
#   BUILD_CLUSTER_GAP     seconds of silence that separate two builds (default 180)
#   DRY_RUN               set to 1 to log deletions without performing them
#   DEBUG                 set to 1 to dump the raw version listing
#
# Exit status is 0 even when pruning is skipped: housekeeping must not fail a
# build whose image was already pushed successfully.

set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:?PACKAGE_NAME is required}"
MIN_IMAGES_TO_KEEP="${MIN_IMAGES_TO_KEEP:-5}"
BUILD_CLUSTER_GAP="${BUILD_CLUSTER_GAP:-180}"
DRY_RUN="${DRY_RUN:-0}"

# Guard against a typo turning into "delete everything".
if ! [[ "${MIN_IMAGES_TO_KEEP}" =~ ^[0-9]+$ ]] || [ "${MIN_IMAGES_TO_KEEP}" -lt 1 ]; then
  echo "::error::MIN_IMAGES_TO_KEEP must be an integer >= 1 (got '${MIN_IMAGES_TO_KEEP}')."
  exit 1
fi

owner="${GITHUB_REPOSITORY%%/*}"
if [ -z "${owner}" ] || [ "${owner}" = "${GITHUB_REPOSITORY}" ]; then
  echo "::error::GITHUB_REPOSITORY must be 'owner/repo' (got '${GITHUB_REPOSITORY:-<unset>}')."
  exit 1
fi
versions_url="users/${owner}/packages/container/${PACKAGE_NAME}/versions"

workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT
versions_tsv="${workdir}/versions.tsv"

# Paginate: the API caps pages at 100.
#   .id                      version id, what DELETE takes
#   .created_at              when this version was published (ISO-8601 UTC)
#   .name                    image digest (unique per version; not a grouping key)
#   .metadata.container.tags tags pointing at this version, if any
if ! gh api --paginate "${versions_url}?per_page=100" \
  --jq '.[] | [.id, .created_at, .name, ((.metadata.container.tags // []) | join(","))] | @tsv' \
  > "${versions_tsv}"; then
  echo "::warning::Could not list package versions; skipping prune."
  exit 0
fi

if [ "${DEBUG:-0}" = "1" ]; then
  echo "--- raw versions (id | created_at | digest | tags) ---"
  awk -F'\t' '{ printf "  %s | %s | %s | %s\n", $1, $2, $3, $4 }' "${versions_tsv}"
  echo "--- end raw versions ---"
fi

version_count=$(grep -c . "${versions_tsv}" || true)
if [ "${version_count}" -eq 0 ]; then
  echo "No published versions found; nothing to do."
  exit 0
fi

# Normalise to "epoch<TAB>id<TAB>created_at<TAB>tags", sorted oldest first.
#
# Epoch seconds come from a portable civil-date conversion rather than `date -d`
# (GNU-only) so the script behaves the same locally and on the runner.
awk -F'\t' '
  function civil_epoch(y, m, d, hh, mi, ss,   era, yoe, doy, doe) {
    if (m <= 2) { y -= 1; m += 12 }
    era = int(y / 400)
    yoe = y - era * 400
    doy = int((153 * (m - 3) + 2) / 5) + d - 1
    doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
    return (era * 146097 + doe - 719468) * 86400 + hh * 3600 + mi * 60 + ss
  }
  {
    if (split($2, t, /[-T:Z]/) < 6) { print "unparsable created_at: " $2 > "/dev/stderr"; exit 1 }
    epoch = civil_epoch(t[1] + 0, t[2] + 0, t[3] + 0, t[4] + 0, t[5] + 0, t[6] + 0)
    printf "%d\t%s\t%s\t%s\n", epoch, $1, $2, $4
  }
' "${versions_tsv}" | sort -n -k1,1 -k2,2 > "${workdir}/by_time.tsv"

# Assign a cluster (build) number: a gap longer than BUILD_CLUSTER_GAP starts a
# new build. Cluster numbers therefore increase with time.
awk -F'\t' -v gap="${BUILD_CLUSTER_GAP}" '
  { if (NR == 1 || $1 - previous > gap) cluster++; previous = $1
    printf "%d\t%s\n", cluster, $0 }
' "${workdir}/by_time.tsv" > "${workdir}/clustered.tsv"

build_count=$(awk -F'\t' 'END { print $1 + 0 }' "${workdir}/clustered.tsv")
echo "Found ${version_count} version(s) across ${build_count} image build(s); keeping the newest ${MIN_IMAGES_TO_KEEP} build(s)."

if [ "${build_count}" -le "${MIN_IMAGES_TO_KEEP}" ]; then
  echo "Nothing to prune."
  exit 0
fi

# Builds older than the newest N are due for removal.
cutoff=$(( build_count - MIN_IMAGES_TO_KEEP ))

# A build carrying `latest` is never removed, even if it somehow fell outside
# the newest N: deleting `latest` would break every `docker pull` of it.
awk -F'\t' -v cutoff="${cutoff}" '
  {
    cluster = $1; id = $3; created = $4; tags = $5
    if (cluster <= cutoff) {
      if (tags ~ /(^|,)latest(,|$)/) protected[cluster] = 1
      order[++n] = cluster "\t" id "\t" created "\t" tags
    }
  }
  END {
    for (i = 1; i <= n; i++) {
      split(order[i], f, "\t")
      if (f[1] in protected) { printf "SKIP\t%s\t%s\t%s\n", f[2], f[3], f[4] }
      else { printf "DELETE\t%s\t%s\t%s\n", f[2], f[3], f[4] }
    }
  }
' "${workdir}/clustered.tsv" > "${workdir}/plan.tsv"

deleted=0
skipped=0
while IFS=$'\t' read -r action id created tags; do
  if [ "${action}" = "SKIP" ]; then
    echo "Skipping version ${id} (created ${created}): its build carries the 'latest' tag."
    skipped=$(( skipped + 1 ))
    continue
  fi

  if [ "${DRY_RUN}" = "1" ]; then
    echo "[dry-run] Would delete version ${id} (created ${created}, tags: ${tags:-none})."
    deleted=$(( deleted + 1 ))
    continue
  fi

  echo "Deleting version ${id} (created ${created}, tags: ${tags:-none})."
  if gh api --method DELETE "${versions_url}/${id}"; then
    deleted=$(( deleted + 1 ))
  else
    echo "::warning::Failed to delete version ${id}; continuing."
  fi
done < "${workdir}/plan.tsv"

echo "Pruned ${deleted} version(s); kept ${MIN_IMAGES_TO_KEEP} build(s) (skipped ${skipped} 'latest' version(s))."
