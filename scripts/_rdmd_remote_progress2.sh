export PATH=/root/miniconda3/bin:$PATH
du -sh /root/autodl-tmp/models/* /root/autodl-tmp/models/.[!.]* 2>/dev/null
ls -lah /root/autodl-tmp/models/Qwen3-8B
find /root/autodl-tmp/models -name '*.safetensors*' -o -name '*.incomplete' | head
ls -lah /root/autodl-tmp/hf 2>/dev/null | head
find /root/autodl-tmp -name '*Qwen3*' | head
ps -p 2797 -o pid,etime,cmd
