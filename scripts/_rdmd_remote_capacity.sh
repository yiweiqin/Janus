export PATH=/root/miniconda3/bin:$PATH
echo '===HOST==='
hostname
date -Is
uptime
echo '===CPU_MEM==='
nproc
free -h
echo '===LOAD==='
cat /proc/loadavg
echo '===DISK==='
df -h / /root /root/autodl-tmp /root/autodl-fs 2>/dev/null || true
echo '===GPU==='
nvidia-smi
echo '===GPU_QUERY==='
nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,utilization.memory,temperature.gpu,power.draw,power.limit --format=csv
echo '===GPU_PROCS==='
nvidia-smi --query-compute-apps=gpu_uuid,gpu_bus_id,pid,process_name,used_memory --format=csv
echo '===TRAIN_PROCS==='
pgrep -af 'train_qlora|python.*train|accelerate|deepspeed|torchrun' || true
echo '===PID_FILE==='
cat /root/autodl-tmp/rdmd_runs/qlora-v2.pid 2>/dev/null || true
ps -fp $(cat /root/autodl-tmp/rdmd_runs/qlora-v2.pid 2>/dev/null) 2>/dev/null || true
echo '===LOG_TAIL==='
tail -n 20 /root/autodl-tmp/rdmd_runs/qlora-v2.train.log 2>/dev/null || true
echo '===MODELS==='
du -sh /root/autodl-tmp/models /root/autodl-tmp/hf /root/autodl-tmp/rdmd_runs /root/autodl-tmp/Janus 2>/dev/null || true
ls -ld /root/autodl-tmp/models/* 2>/dev/null || true
echo '===CUDA_ENV==='
echo CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-unset}"
cat /root/autodl-tmp/rdmd_runs/qlora-v2.pid.env 2>/dev/null || true
echo '===DONE==='
