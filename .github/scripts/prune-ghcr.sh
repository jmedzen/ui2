#!/usr/bin/env bash
#
# Prune old GHCR container images, keeping the newest N *builds*.
#
# Why this is not "keep the newest N versions":
#
# Each run publishes the same image under several tags (latest, main, sha-xxxx,
# and a semver tag when the version changes). GHCR stores one package *version*
# per tag, so a single build shows up as three versions. Preserving "the newest
# 5 versions" therefore preserved barely one and a half builds, and — worse —
# whichever count it was given, it cut through a build's tag set: it would keep
# `latest` and `main` while deleting the matching `sha-xxxx`, leaving an image
# whose tags no longer agree.
#
# Grouping by image digest fixes both problems: all tags of one build share a
# digest, so a build is kept or dropped as a unit, and "keep 5" now means five
# complete, independently usable images.
#
# `latest` is never deleted, even if it somehow fell outside the newest N.
#
# Environment:
#   GH_TOKEN              required; needs read:packages and write:packages
#   PACKAGE_NAME          container package name, e.g. ui2
#   MIN_IMAGES_TO_KEEP    number of newest builds to keep (default 5)
#   GITHUB_REPOSITORY     owner/repo, provided by Actions
#   DRY_RUN               set to 1 to log deletions without performing them
#
# Exit status is 0 even when pruning is skipped: housekeeping must not fail a
# build whose image was already pushed successfully.

set -euo pipefail

PACKAGE_NAME="${PACKAGE_NAME:?PACKAGE_NAME is required}"
MIN_IMAGES_TO_KEEP="${MIN_IMAGES_TO_KEEP:-5}"
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
#   .name                    image digest for container packages (the build key)
#   .metadata.container.tags every tag pointing at this version
if ! gh api --paginate "${versions_url}?per_page=100" \
  --jq '.[] | [.id, .created_at, .name, ((.metadata.container.tags // []) | join(","))] | @tsv' \
  > "${versions_tsv}"; then
  echo "::warning::Could not list package versions; skipping prune."
  exit 0
fi

# DEBUG=1 dumps the raw projection so the grouping key can be verified against
# the registry's real shape. Off by default; it is noisy and lists every version.
if [ "${DEBUG:-0}" = "1" ]; then
  echo "--- raw versions (id, created_at, name, tags) ---"
  awk -F'\t' '{ printf "  %s | %s | name=%s | tags=%s\n", $1, $2, $3, $4 }' "${versions_tsv}"
  echo "--- end raw versions ---"
fi

version_count=$(grep -c . "${versions_tsv}" || true)
if [ "${version_count}" -eq 0 ]; then
  echo "No published versions found; nothing to do."
  exit 0
fi

# One row per version: digest, id, created_at, tags.
# A version without a digest is bucketed by minute so it is not merged with
# unrelated untagged versions.
awk -F'\t' '{
  digest = $3
  if (digest == "" || digest == "null") digest = "untagged:" substr($2, 1, 16)
  printf "%s\t%s\t%s\t%s\n", digest, $1, $2, $4
}' "${versions_tsv}" > "${workdir}/tagged.tsv"

# Newest-first list of distinct builds.
awk -F'\t' '{ if ($3 > newest[$1]) newest[$1] = $3 }
  END { for (d in newest) printf "%s\t%s\n", newest[d], d }' "${workdir}/tagged.tsv" \
  | sort -r > "${workdir}/builds.tsv"

build_count=$(grep -c . "${workdir}/builds.tsv" || true)
echo "Found ${version_count} version(s) across ${build_count} image build(s); keeping the newest ${MIN_IMAGES_TO_KEEP} build(s)."

if [ "${build_count}" -le "${MIN_IMAGES_TO_KEEP}" ]; then
  echo "Nothing to prune."
  exit 0
fi

# Everything past the newest N builds is due for removal.
tail -n "+$(( MIN_IMAGES_TO_KEEP + 1 ))" "${workdir}/builds.tsv" | cut -f2 \
  > "${workdir}/doomed_builds.txt"

deleted=0
blocked=0
while IFS=$'\t' read -r _digest id created tags; do
  case ",${tags}," in
    *,latest,*)
      echo "Skipping version ${id} (created ${created}): it carries the 'latest' tag."
      blocked=$(( blocked + 1 ))
      continue
      ;;
  esac

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
done < <(awk -F'\t' '
  NR == FNR { doomed[$1] = 1; next }
  ($1 in doomed)
' "${workdir}/doomed_builds.txt" "${workdir}/tagged.tsv")

echo "Pruned ${deleted} version(s); kept ${MIN_IMAGES_TO_KEEP} build(s)${blocked:+ (skipped ${blocked} 'latest' version(s))}."
