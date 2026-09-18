export PATH=/root/miniconda3/bin:$PATH
du -sh /root/autodl-tmp/models /root/autodl-tmp/hf /root/autodl-tmp/rdmd-env 2>/dev/null
ls -lh /root/autodl-tmp/models/Qwen3-8B 2>/dev/null | head -30
df -h /root/autodl-tmp
ps -ef | grep -E 'snapshot|huggingface|train_qlora|python' | grep -v grep | head
