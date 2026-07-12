#!/usr/bin/env bash
# Runs a SonarQube scan against $SONAR_HOST_URL using $SONAR_TOKEN.
# Locally: export SONAR_HOST_URL / SONAR_TOKEN yourself, or `source ../../tools/sonarqube/.env`
# from the workspace root first. In CI these come from repo secrets.
set -euo pipefail

: "${SONAR_HOST_URL:?SONAR_HOST_URL is not set}"
: "${SONAR_TOKEN:?SONAR_TOKEN is not set}"

docker run --rm --network host \
  -v "$PWD":/usr/src \
  sonarsource/sonar-scanner-cli \
  -Dsonar.host.url="$SONAR_HOST_URL" \
  -Dsonar.token="$SONAR_TOKEN"
