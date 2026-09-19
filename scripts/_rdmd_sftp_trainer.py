"""One-shot SFTP helper: push scripts/train_qlora_rdmd.py to the box.

Endpoint comes from the environment (RDMD_SSH_HOST / RDMD_SSH_PORT / RDMD_SSH_USER) so this
survives a box swap like every other _rdmd_* tool. It used to hardcode host:port, which made
it the single script that silently kept talking to the OLD box after a clone.
"""
import os
from pathlib import Path
import paramiko

from _rdmd_ssh_target import connect as _connect_ssh

client = _connect_ssh()
sftp = client.open_sftp()
local = Path("scripts/train_qlora_rdmd.py")
remote = "/root/autodl-tmp/Janus/scripts/train_qlora_rdmd.py"
sftp.put(str(local), remote)
sftp.close()
print("uploaded", local.stat().st_size)
client.close()
