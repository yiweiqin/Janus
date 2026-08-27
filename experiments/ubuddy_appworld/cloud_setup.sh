#!/usr/bin/env bash
set -euo pipefail

# Run on Ubuntu 22.04/24.04 from the Janus repository root.
# Secrets are intentionally read from the shell environment and never written.

ROOT="${JANUS_ROOT:-$PWD}"
BENCH="${BENCHMARK_ROOT:-$ROOT/benchmarks}"
mkdir -p "$BENCH"

if [[ ! -d "$BENCH/appworld-official/.git" ]]; then
  git clone https://github.com/StonyBrookNLP/appworld.git "$BENCH/appworld-official"
fi
git -C "$BENCH/appworld-official" lfs pull
python3.11 -m venv "$BENCH/appworld-official/.venv311"
"$BENCH/appworld-official/.venv311/bin/python" -m pip install --upgrade pip
"$BENCH/appworld-official/.venv311/bin/pip" install -e "$BENCH/appworld-official"
export APPWORLD_ROOT="$BENCH/appworld-runtime"
(
  cd "$BENCH/appworld-official"
  "$BENCH/appworld-official/.venv311/bin/appworld" install --repo
)
"$BENCH/appworld-official/.venv311/bin/appworld" download data --root "$APPWORLD_ROOT"

if [[ ! -d "$BENCH/marble" ]]; then
  git clone https://github.com/ulab-uiuc/MARBLE.git "$BENCH/marble"
fi
python3.11 -m venv "$BENCH/marble/.venv311"
"$BENCH/marble/.venv311/bin/pip" install -e "$BENCH/marble"

if [[ ! -d "$BENCH/agents-failure-attribution" ]]; then
  git clone https://github.com/ag2ai/Agents_Failure_Attribution.git "$BENCH/agents-failure-attribution"
fi
if [[ ! -d "$BENCH/who-and-when" ]]; then
  mkdir -p "$BENCH/who-and-when"
  if command -v hf >/dev/null 2>&1; then
    hf download Kevin355/Who_and_When --repo-type dataset --local-dir "$BENCH/who-and-when"
  else
    echo "hf CLI unavailable; install huggingface_hub before the Who&When attribution stage" >&2
  fi
fi

export APPWORLD_PYTHON="$BENCH/appworld-official/.venv311/bin/python"
"$APPWORLD_PYTHON" scripts/generate_ubuddy_appworld_manifest.py --root "$APPWORLD_ROOT"
cat > "$ROOT/.ubuddy_appworld_env" <<EOF
export APPWORLD_ROOT="$APPWORLD_ROOT"
export APPWORLD_PYTHON="$APPWORLD_PYTHON"
export MARBLE_ROOT="$BENCH/marble"
export WHO_AND_WHEN_ROOT="$BENCH/who-and-when"
EOF
npm run experiment:ubuddy:appworld:doctor
npm run experiment:ubuddy:appworld:manifest

echo "Environment file written to $ROOT/.ubuddy_appworld_env"
echo "Run: source $ROOT/.ubuddy_appworld_env"
