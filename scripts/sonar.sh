#!/usr/bin/env bash
# Runs a SonarQube scan against $SONAR_HOST_URL using $SONAR_TOKEN.
# Locally: export SONAR_HOST_URL / SONAR_TOKEN yourself, or `source ../../tools/sonarqube/.env`
# from the workspace root first. In CI these come from repo secrets.
#
# For coverage to be imported, generate both lcov files first:
#   bun run test:coverage && bun run test:it:coverage
set -euo pipefail

: "${SONAR_HOST_URL:?SONAR_HOST_URL is not set}"
# Local tooling stores the analysis token as SONAR_ANALYSIS_TOKEN.
if [[ -z "${SONAR_TOKEN:-}" && -n "${SONAR_ANALYSIS_TOKEN:-}" ]]; then
  SONAR_TOKEN="$SONAR_ANALYSIS_TOKEN"
fi
: "${SONAR_TOKEN:?SONAR_TOKEN (or SONAR_ANALYSIS_TOKEN) is not set}"

# Pin the scanner image so local and CI analysis use the same CLI.
SONAR_SCANNER_IMAGE='sonarsource/sonar-scanner-cli@sha256:23ca0f137965d9dff2198074043fd48d386280bc5d0ccac8c8349cea4cf096a9'
SONAR_PROJECT_ARGS=()
if [[ -n "${SONAR_PROJECT_KEY:-}" ]]; then
  SONAR_PROJECT_ARGS+=("-Dsonar.projectKey=$SONAR_PROJECT_KEY")
fi

docker run --rm --network host \
  -v "$PWD":/usr/src \
  "$SONAR_SCANNER_IMAGE" \
  "${SONAR_PROJECT_ARGS[@]}" \
  -Dsonar.host.url="$SONAR_HOST_URL" \
  -Dsonar.token="$SONAR_TOKEN"
