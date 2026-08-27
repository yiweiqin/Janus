import crypto from 'node:crypto';

import { all, get, run } from '../../../db.js';
import { newId, nowIso } from '../../../utils.js';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_COUNT = 300;
const TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export function installEmojiFavoriteMethods(prototype) {
  prototype.listEmojiFavorites = function listEmojiFavorites() {
    const user = this.requireUser();
    return all(this.db, 'SELECT * FROM emoji_favorites WHERE user_id=? ORDER BY sort_order,created_at').map((row) => normalizeFavoriteRow(this, row));
  };
  prototype.addEmojiFavorite = function addEmojiFavorite({ kind = 'image', value = '', filename = '', contentType = '', dataBase64 = '', sha256 = '', sortOrder = 0 } = {}) {
    const user = this.requireUser();
    const cleanKind = kind === 'unicode' ? 'unicode' : 'image';
    const data = cleanKind === 'image' ? Buffer.from(String(dataBase64 || '').replace(/^data:[^,]+,/, ''), 'base64') : Buffer.alloc(0);
    if (cleanKind === 'image') {
      if (!data.length || data.length > MAX_BYTES) throw new Error('单个表情不能超过 2 MB。');
      if (!TYPES.has(String(contentType || '').toLowerCase())) throw new Error('仅支持 PNG、JPG、WebP、GIF。');
    }
    const digest = cleanKind === 'image' ? crypto.createHash('sha256').update(data).digest('hex') : '';
    if (sha256 && sha256.toLowerCase() !== digest) throw new Error('表情校验失败。');
    if (get(this.db, 'SELECT id FROM emoji_favorites WHERE user_id=? AND kind=? AND sha256=?', [user.id, cleanKind, digest])) throw new Error('该表情已经收藏。');
    if (Number(get(this.db, 'SELECT COUNT(*) AS count FROM emoji_favorites WHERE user_id=?', [user.id])?.count || 0) >= MAX_COUNT) throw new Error('最多收藏 300 个表情。');
    const id = newId('emoji_favorite');
    const storedValue = cleanKind === 'image' ? `data:${contentType};base64,${data.toString('base64')}` : String(value || '').trim();
    const now = nowIso();
    run(this.db, `INSERT INTO emoji_favorites(id,user_id,kind,value,filename,content_type,size_bytes,sha256,local_path,sort_order,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [id, user.id, cleanKind, storedValue, String(filename || '').slice(0, 180), String(contentType || '').slice(0, 100), data.length, digest, '', Number(sortOrder || 0), now, now]);
    return normalizeFavoriteRow(this, get(this.db, 'SELECT * FROM emoji_favorites WHERE id=?', [id]));
  };
  prototype.removeEmojiFavorite = function removeEmojiFavorite({ id = '' } = {}) {
    const user = this.requireUser();
    run(this.db, 'DELETE FROM emoji_favorites WHERE id=? AND user_id=?', [String(id || ''), user.id]);
    return { ok: true };
  };
  prototype.reorderEmojiFavorites = function reorderEmojiFavorites({ ids = [] } = {}) {
    const user = this.requireUser();
    for (const [index, id] of (Array.isArray(ids) ? ids : []).entries()) run(this.db, 'UPDATE emoji_favorites SET sort_order=?,updated_at=? WHERE id=? AND user_id=?', [index, nowIso(), String(id || ''), user.id]);
    return this.listEmojiFavorites();
  };
}

function normalizeFavoriteRow(auth, row = {}) {
  return {
    id: row.id, kind: row.kind, value: row.value || '', name: row.filename || row.value || '表情', filename: row.filename || '',
    contentType: row.content_type || '', size: Number(row.size_bytes || 0), sha256: row.sha256 || '', path: row.local_path || '',
    url: row.kind === 'image' ? row.value || '' : '', sortOrder: Number(row.sort_order || 0),
    createdAt: row.created_at || '', updatedAt: row.updated_at || '',
  };
}
