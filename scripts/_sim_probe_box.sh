#!/usr/bin/env bash
# 只读探针：sim_task_group 在盒子上需要哪些依赖、现在有没有。
for p in \
  /root/Janus/src/shared/contracts/uBuddyReverseDetective.js \
  /root/Janus/src/shared/contracts/uBuddyPlanExec.js \
  /root/Janus/src/shared/contracts/uBuddyCollaborationGraph.js \
  /root/Janus/experiments \
  /root/autodl-tmp/Janus/experiments \
  /root/autodl-tmp/rdmd_detective_dataset \
  /root/Janus/schema.json \
  /root/autodl-tmp/Janus/schema.json \
  /root/Janus/cloud/src/modules/rdmd/privacy.mjs \
  /root/Janus/scripts/rdmd_cloud_e2e.mjs \
  /root/Janus/package.json ; do
  if [ -e "$p" ]; then echo "YES $p"; else echo "NO  $p"; fi
done

echo "--- 找 detective dataset / sim 目录 ---"
find /root -maxdepth 4 -name 'rdmd_detective_dataset' -type d 2>/dev/null | head
find /root -maxdepth 4 -name 'sim_task_group' -type d 2>/dev/null | head

echo "--- agent roster（cpdb 全量 600 specialist）---"
for p in \
  /root/Janus/experiments/cpdb_org_world/data/full/agent_profiles.jsonl \
  /root/autodl-tmp/Janus/experiments/cpdb_org_world/data/full/agent_profiles.jsonl ; do
  if [ -f "$p" ]; then echo "YES $p ($(wc -l < "$p") lines)"; else echo "NO  $p"; fi
done

echo "--- node 是否能跑 ESM ---"
NODE=/root/.nvm/versions/node/v22.23.2/bin/node
"$NODE" -e "console.log('node', process.version)"
