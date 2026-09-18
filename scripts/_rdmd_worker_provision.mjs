/**
 * 给 GPU 盒上的 RDMD worker 配一个 **device grant**（在生产里跑，不是在 e2e 里）。
 *
 * 为什么必须是独立的一步：`cloud_sync_grants` 里只存 `token_hash`，**明文 token 只在
 * 签发那一刻可见**。所以 worker 的凭据不可能从库里"读出来" —— 只能在这里现签发一次、
 * 落到盒子上一个 0600 的文件里，之后由 daemon 读。把 token 写进日志或命令行参数都是
 * 泄露（`ps` 与日志都会被别人看到），所以本脚本只把"签发成功 + 过期时间"打出来。
 *
 * 为什么需要一个新的**服务身份**而不是借某个用户的 device grant：worker 是跨用户的
 * （一个 worker 池服务所有用户的作业，云侧 `claim` 本来就不按用户过滤），所以它需要一个
 * 专用身份，而不是某个人桌面的凭据。用一个专用 users 行 + 专用 device 是最小的可用形态，
 * 也让"这条 claim 是谁领的"在审计里一眼可辨。
 *
 * 凭据的寿命：云侧 `issueToken` 的 ttlDays 上限是 90 天（`Math.min(90, ttlDays)`）。
 * 到期后 worker 会拿到 401 并**自己退出**（不许用失效凭据空转），这时重跑本脚本即可。
 * 这是刻意的：一个永不失效的推理凭据比每周重签发更危险。
 *
 * 用法（在 GPU 盒上，`RDMD_DEVICE_GRANT=dgr_... node scripts/_rdmd_worker_provision.mjs --once`）：
 *   缺 token 时打印"还没有凭据"并以 2 退出，让调用方去 provision，而不是自己去猜。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { createPgPool } from '../cloud/src/db.mjs';
import { signAccessToken } from '../cloud/src/security.mjs';
import { deviceGrantProofMessage } from '../src/shared/taskMemoryCrypto.js';

const API = String(process.env.RDMD_API || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const USER_ID = String(process.env.RDMD_WORKER_USER || 'svc_rdmd_inference_worker');
const DEVICE_ID = String(process.env.RDMD_WORKER_DEVICE || `gpu-${os.hostname()}`);
const KEY_DIR = String(process.env.RDMD_WORKER_KEYDIR || '/root/autodl-tmp/rdmd_runs/worker_keys');
const ENV_OUT = String(process.env.RDMD_WORKER_ENV_OUT || '/root/.config/janus/rdmd_worker.env');
// 90 天是云侧允许的上限（见 deviceGrants.issueToken 的 Math.min(90, …)）。
const TTL_DAYS = Math.max(1, Math.min(90, Number(process.env.RDMD_WORKER_GRANT_DAYS || 90)));
const SCOPES = ['rdmd:infer'];

function log(message) {
  console.log(`[provision] ${message}`);
}

function fail(message) {
  console.error(`[provision] [error] ${message}`);
  process.exit(1);
}

/** 加载或生成设备密钥对。复用已有的：每次换密钥都会让旧 device 行变成孤儿。 */
function loadOrCreateKeys() {
  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const privatePath = path.join(KEY_DIR, 'device_private.pem');
  const publicPath = path.join(KEY_DIR, 'device_public.pem');
  if (fs.existsSync(privatePath) && fs.existsSync(publicPath)) {
    log(`复用已有密钥对 ${privatePath}`);
    return { privateKey: fs.readFileSync(privatePath, 'utf8'), publicKey: fs.readFileSync(publicPath, 'utf8'), created: false };
  }
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.writeFileSync(privatePath, privateKey, { mode: 0o600 });
  fs.writeFileSync(publicPath, publicKey, { mode: 0o644 });
  log(`生成新密钥对 ${privatePath}（0600）`);
  return { privateKey, publicKey, created: true };
}

async function postJson(route, body, { token = '' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${API}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: response.status, body: parsed };
}

async function main() {
  const databaseUrl = String(process.env.DATABASE_URL || '');
  if (!databaseUrl) fail('DATABASE_URL 未设置：本脚本要在 remote.env 生效的环境里跑');
  const jwtSecret = String(process.env.JWT_SECRET || '');
  if (!jwtSecret) fail('JWT_SECRET 未设置：签发 device grant 需要一个用户身份的 JWT（两处路由都用 auth）');

  // 云 API 必须活着：provision 的每一步都是走它，绕过去直接写库会漏掉 proof 校验。
  const health = await fetch(`${API}/healthz`).then((response) => response.status).catch(() => 0);
  if (health !== 200) fail(`云 API 不可达（${API}/healthz -> ${health}）`);

  const pool = createPgPool(databaseUrl);
  try {
    // 服务身份：最小的 users 行，不带任何真实凭据（password_hash 是占位符，永远不用于登录）。
    await pool.query(
      `INSERT INTO users (id,email,display_name,password_hash,email_verified,role)
       VALUES ($1,$2,$3,$4,true,'member') ON CONFLICT (id) DO NOTHING`,
      [USER_ID, `${USER_ID}@internal.invalid`, 'RDMD Inference Worker', 'not-a-login-hash'],
    );
    log(`服务身份就绪 user=${USER_ID}`);

    const { publicKey, privateKey, created } = loadOrCreateKeys();
    const token = signAccessToken({ userId: USER_ID, secret: jwtSecret, expiresInSeconds: 900 });

    // 注册设备。首次注册会自动批准（云侧 approvedCount === 0 的分支），所以这里不该出现
    // pending —— 真出现就说明这个身份已经有别的设备了，需要显式批准，不该由本脚本偷偷放行。
    const registered = await postJson('/api/device-grants/register', {
      deviceId: DEVICE_ID, displayName: 'RDMD GPU worker', platform: process.platform, arch: process.arch, publicKey,
    }, { token });
    if (![200, 201, 202].includes(registered.status)) {
      fail(`注册设备失败 HTTP ${registered.status}: ${JSON.stringify(registered.body)}`);
    }
    const deviceStatus = String(registered.body?.status || '');
    log(`设备注册 deviceId=${DEVICE_ID} status=${deviceStatus}${created ? '（新建密钥）' : ''}`);
    if (deviceStatus !== 'approved') {
      fail(`设备状态是 ${deviceStatus}，不是 approved。需要由已有设备批准，见 cloud/src/modules/sync/deviceGrants.mjs#approve`);
    }

    // 用设备私钥对 proof 签名。**这一步是 device grant 的全部安全性所在**：
    // 没有私钥就签不出 proof，也就换不到 token。
    const timestamp = new Date().toISOString();
    const nonce = crypto.randomUUID();
    const signature = crypto.sign('sha256',
      Buffer.from(deviceGrantProofMessage({ userId: USER_ID, deviceId: DEVICE_ID, scopes: SCOPES, timestamp, nonce }), 'utf8'),
      privateKey).toString('base64');

    const issued = await postJson(`/api/device-grants/${encodeURIComponent(DEVICE_ID)}/token`, {
      scopes: SCOPES, ttlDays: TTL_DAYS, proof: { timestamp, nonce, signature },
    }, { token });
    if (issued.status !== 201) fail(`签发 device grant 失败 HTTP ${issued.status}: ${JSON.stringify(issued.body)}`);
    const grantToken = String(issued.body?.token || '');
    if (!grantToken.startsWith('dgr_')) fail('返回的 token 形状不对（应形如 dgr_…）');
    const scopes = Array.isArray(issued.body?.scopes) ? issued.body.scopes : [];
    if (!scopes.includes('rdmd:infer')) fail(`拿到的 scope 里没有 rdmd:infer：${JSON.stringify(scopes)}`);
    if (scopes.length !== 1) {
      // worker 只需要一项权限；多出来的 scope 是权限蔓延，值得当场看见。
      log(`[warn] grant 带了额外 scope：${JSON.stringify(scopes)}（worker 只需要 rdmd:infer）`);
    }

    // 落盘给 daemon 用。0600 + 只写需要的变量；token 不进日志、不进命令行。
    fs.mkdirSync(path.dirname(ENV_OUT), { recursive: true, mode: 0o700 });
    fs.writeFileSync(ENV_OUT,
      '# 由 scripts/_rdmd_worker_provision.mjs 生成，勿提交、勿打印。\n'
      + `export RDMD_DEVICE_GRANT=${grantToken}\n`
      + `export RDMD_WORKER_ID=${DEVICE_ID}\n`,
      { mode: 0o600 });
    fs.chmodSync(ENV_OUT, 0o600);

    log(`签发成功 scope=${JSON.stringify(scopes)} expiresAt=${String(issued.body?.expiresAt || '')}`);
    log(`凭据已写入 ${ENV_OUT}（0600，${grantToken.length} 字符）`);
    log(`worker 设备=deviceId:${DEVICE_ID} user:${USER_ID}`);
    console.log('provision_ok');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[provision] [error] ${error?.stack || error}`);
  process.exit(1);
});
