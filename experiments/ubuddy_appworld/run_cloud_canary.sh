#!/usr/bin/env bash
set -euo pipefail

ROOT="${JANUS_ROOT:-$PWD}"
source "$ROOT/.ubuddy_appworld_env"
: "${CRS_OAI_KEY:?CRS_OAI_KEY is required}"
: "${OPENAI_BASE_URL:?OPENAI_BASE_URL is required}"
export UBUDDY_APPWORLD_ENABLE_REAL=1
export UBUDDY_APPWORLD_MODEL="${UBUDDY_APPWORLD_MODEL:-gpt-5.4-mini}"
export UBUDDY_APPWORLD_MAX_STEPS_PER_SUBTASK="${UBUDDY_APPWORLD_MAX_STEPS_PER_SUBTASK:-4}"

npm run experiment:ubuddy:appworld:doctor
npm run experiment:ubuddy:appworld:canary -- --real --model

