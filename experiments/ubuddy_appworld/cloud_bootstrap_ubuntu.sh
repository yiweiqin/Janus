#!/usr/bin/env bash
set -euo pipefail

# Run once on a fresh Ubuntu 22.04/24.04 server.
sudo apt-get update
sudo apt-get install -y git git-lfs curl ca-certificates build-essential software-properties-common python3.11 python3.11-venv
git lfs install

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

python3.11 -m pip install --user --upgrade huggingface_hub || true
echo "Bootstrap complete. Next: bash experiments/ubuddy_appworld/cloud_setup.sh"

