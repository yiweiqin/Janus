#!/usr/bin/env bash
set -euo pipefail

# Remote-only setup for the official AppWorld dependency used by OrgBench v2.
ROOT="${JANUS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
BENCH="${BENCHMARK_ROOT:-$ROOT/benchmarks}"
APPWORLD_REPO="${APPWORLD_REPO:-$BENCH/appworld-official}"
APPWORLD_ROOT="${APPWORLD_ROOT:-$BENCH/appworld-runtime}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

mkdir -p "$BENCH"
if [[ ! -d "$APPWORLD_REPO/.git" ]]; then
  git clone https://github.com/StonyBrookNLP/appworld.git "$APPWORLD_REPO"
fi
git -C "$APPWORLD_REPO" lfs pull || true

if [[ ! -x "$APPWORLD_REPO/.venv/bin/python" ]]; then
  "$PYTHON_BIN" -m venv "$APPWORLD_REPO/.venv"
fi
"$APPWORLD_REPO/.venv/bin/python" -m pip install --upgrade pip
"$APPWORLD_REPO/.venv/bin/pip" install -e "$APPWORLD_REPO"
(
  cd "$APPWORLD_REPO"
  "$APPWORLD_REPO/.venv/bin/appworld" install --repo
)
"$APPWORLD_REPO/.venv/bin/appworld" download data --root "$APPWORLD_ROOT"

export APPWORLD_ROOT APPWORLD_PYTHON="$APPWORLD_REPO/.venv/bin/python" JANUS_ROOT="$ROOT"
"$APPWORLD_PYTHON" "$ROOT/scripts/generate_orgbench_manifests.py" --appworld-root "$APPWORLD_ROOT" --output-dir "$ROOT/experiments/ubuddy_orgbench"
cat > "$ROOT/.orgbench_env" <<EOF
export JANUS_ROOT="$ROOT"
export BENCHMARK_ROOT="$BENCH"
export APPWORLD_ROOT="$APPWORLD_ROOT"
export APPWORLD_PYTHON="$APPWORLD_PYTHON"
EOF
echo "OrgBench v2 AppWorld setup complete. APPWORLD_ROOT=$APPWORLD_ROOT"
echo "Run: source $ROOT/.orgbench_env"
