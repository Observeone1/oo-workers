#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKERS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMPOSE_FILE="$WORKERS_DIR/docker-compose.dev.yml"
SESSION_NAME="oo-workers"
POSTGRES_PORT=5442
REDIS_PORT=6479
UI_PORT=3010

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

usage() {
  echo -e "${BOLD}oo-workers dev${NC}"
  echo ""
  echo "Usage: $0 [OPTIONS]"
  echo ""
  echo "Options:"
  echo "  --no-attach   Don't attach to tmux after setup"
  echo "  --logs        Extra tmux window tailing compose logs"
  echo "  --stop        Stop the dev session and infra containers"
  echo "  --help        Show this help"
  exit 0
}

ATTACH=true
SHOW_LOGS=false

for arg in "$@"; do
  case "$arg" in
    --no-attach) ATTACH=false ;;
    --logs)      SHOW_LOGS=true ;;
    --stop)
      echo -e "${YELLOW}Stopping oo-workers dev session...${NC}"
      tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
      docker compose -f "$COMPOSE_FILE" down 2>/dev/null || true
      echo -e "${GREEN}Done.${NC}"
      exit 0
      ;;
    --help|-h) usage ;;
    *)
      echo -e "${RED}Unknown option: $arg${NC}"
      usage
      ;;
  esac
done

if ! docker info >/dev/null 2>&1; then
  echo -e "${RED}✗ Docker is not running. Start Docker first.${NC}"
  exit 1
fi
echo -e "${GREEN}✓ Docker is running.${NC}"

# --- Infra ---
echo -e "\n${YELLOW}Starting dev infra...${NC}"
docker compose -f "$COMPOSE_FILE" up -d --wait
echo -e "  ${GREEN}✓ Postgres${NC} :$POSTGRES_PORT  ${GREEN}✓ Redis${NC} :$REDIS_PORT  ${GREEN}✓ Mailpit${NC} :8025  ${GREEN}✓ RustFS${NC} :9000"

# --- Deps + build + migrate ---
cd "$WORKERS_DIR"
echo -e "\n${YELLOW}Installing dependencies...${NC}"
bun install --silent

echo -e "${YELLOW}Building UI bundle...${NC}"
bun run build:ui

export DATABASE_URL="postgres://oo:oo@localhost:$POSTGRES_PORT/oo_workers"
export REDIS_URL="redis://localhost:$REDIS_PORT"

echo -e "${YELLOW}Running migrations...${NC}"
for attempt in 1 2 3 4 5; do
  if bun src/db/migrate.ts 2>&1; then
    break
  fi
  echo -e "${YELLOW}  Retrying ($attempt/5)...${NC}"
  sleep 2
done

echo -e "${YELLOW}Clearing e2e leftovers...${NC}"
bun scripts/purge-e2e-leftovers.ts --all 2>&1 || echo -e "  ${YELLOW}(purge skipped)${NC}"

# --- Tmux session ---
echo -e "\n${YELLOW}Setting up tmux session: ${BOLD}$SESSION_NAME${NC}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo -e "${YELLOW}! Session already exists. Recreating...${NC}"
  tmux kill-session -t "$SESSION_NAME"
fi

DB_ENV="export DATABASE_URL=postgres://oo:oo@localhost:$POSTGRES_PORT/oo_workers"
RD_ENV="export REDIS_URL=redis://localhost:$REDIS_PORT"

# Window 0: Worker
tmux new-session -d -s "$SESSION_NAME" -n 'worker' -c "$WORKERS_DIR"
tmux send-keys -t "$SESSION_NAME:worker" "$DB_ENV" C-m
tmux send-keys -t "$SESSION_NAME:worker" "$RD_ENV" C-m
tmux send-keys -t "$SESSION_NAME:worker" "bun --watch src/index.ts" C-m

# Window 1: UI server + build watcher
tmux new-window -t "$SESSION_NAME" -n 'ui' -c "$WORKERS_DIR"
tmux send-keys -t "$SESSION_NAME:ui" "$DB_ENV" C-m
tmux send-keys -t "$SESSION_NAME:ui" "$RD_ENV" C-m
tmux send-keys -t "$SESSION_NAME:ui" "export PORT=$UI_PORT" C-m
tmux send-keys -t "$SESSION_NAME:ui" "bun build --watch src/ui/app.ts --outdir public --target browser &" C-m
tmux send-keys -t "$SESSION_NAME:ui" "bun --watch src/ui-server.ts" C-m

# Window 2: Dev shell
tmux new-window -t "$SESSION_NAME" -n 'shell' -c "$WORKERS_DIR"
tmux send-keys -t "$SESSION_NAME:shell" "$DB_ENV" C-m
tmux send-keys -t "$SESSION_NAME:shell" "$RD_ENV" C-m
tmux send-keys -t "$SESSION_NAME:shell" "echo 'Dev shell ready.  API key: bun scripts/create-api-key.ts --name first'" C-m

if [[ "$SHOW_LOGS" == true ]]; then
  tmux new-window -t "$SESSION_NAME" -n 'logs' -c "$WORKERS_DIR"
  tmux send-keys -t "$SESSION_NAME:logs" "docker compose -f $COMPOSE_FILE logs -f" C-m
fi

tmux select-window -t "$SESSION_NAME:worker"

echo -e "${GREEN}✓ Session ready!${NC}"
echo -e "\n${YELLOW}----------------------------------------------${NC}"
echo -e "  ${BOLD}UI:${NC}      http://localhost:$UI_PORT"
echo -e "  ${BOLD}Postgres:${NC} localhost:$POSTGRES_PORT (oo/oo)"
echo -e "  ${BOLD}Redis:${NC}   localhost:$REDIS_PORT"
echo -e "  ${BOLD}Mailpit:${NC} http://localhost:8025"
echo -e "  ${BOLD}RustFS:${NC}  http://localhost:9001 (console)"
echo -e ""
echo -e "  ${BOLD}Attach:${NC}  tmux attach -t $SESSION_NAME"
echo -e "  ${BOLD}Stop:${NC}    $0 --stop"
echo -e ""
if [[ "$SHOW_LOGS" == true ]]; then
  echo -e "  Windows: worker | ui | shell | logs"
else
  echo -e "  Windows: worker | ui | shell"
fi
echo -e "  Navigate: ${BOLD}Ctrl+b n${NC} or ${BOLD}Ctrl+b <num>${NC}"
echo -e "${YELLOW}----------------------------------------------${NC}"

if [[ "$ATTACH" == true ]]; then
  read -rp "Attach now? [Y/n] " answer
  if [[ ! "$answer" =~ ^[Nn]$ ]]; then
    tmux attach -t "$SESSION_NAME"
  fi
fi
