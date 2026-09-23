import crypto from 'node:crypto'
import { db } from './db.js'
import { seedFarm, ensureLegacySeed } from './seed.js'
import { claimIfNeeded } from './auth.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 农场内所有数据表（解散农场时整体清理）
const FARM_TABLES = [
  'plots', 'crops', 'inventory', 'buildings', 'animals',
  'weather_events', 'weather_log', 'irrigation', 'irrigation_report',
  'production_jobs', 'crop_varieties', 'breeding_trials'
]

function uniqueName(base, existing) {
  let name = base
  let i = 2
  const set = new Set(existing)
  while (set.has(name)) name = `${base}·${i++}`
  return name
}

// 创建新农场：创建人成为场主，初始化一份独立存档
export function createFarm(userId, rawName) {
  const base = String(rawName || '').trim().slice(0, 20) || '新农场'
  const usedNames = q('SELECT name FROM farms').map((r) => r.name)
  const name = uniqueName(base, usedNames)
  const now = Date.now()
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = run('INSERT INTO farms (name,owner_id,created_at) VALUES (?,?,?)', name, userId, now)
    const farmId = Number(r.lastInsertRowid)
    seedFarm(farmId, name)
    run("INSERT INTO farm_members (farm_id,user_id,role,status,joined_at) VALUES (?,?, 'owner','active',?)",
      farmId, userId, now)
    db.exec('COMMIT')
    return { id: farmId, name }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束 */ }
    throw e
  }
}

// 认领旧单人存档（id=1 且 owner 为空时原子成功；已被认领则返回当前关系）
export function claimFarm1(userId) {
  ensureLegacySeed()
  const claimed = claimIfNeeded(1, userId)
  const m = q1('SELECT * FROM farm_members WHERE farm_id=1 AND user_id=?', userId)
  return { ok: !!m, claimed: claimed && !!m, alreadyMember: !!m, status: m?.status || null }
}

// ===== 邀请码 =====
function genCode() {
  // 去掉易混字符的 8 位码
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  const bytes = crypto.randomBytes(8)
  for (const b of bytes) code += alphabet[b % alphabet.length]
  return code
}

export function createInvite(farmId, userId, { role = 'member', maxUses = 1, ttlMs = 48 * 3600 * 1000 } = {}) {
  const grantRole = role === 'admin' ? 'admin' : 'member'
  const uses = Math.max(1, Math.min(Math.floor(Number(maxUses) || 1), 50))
  const ttl = Math.max(5 * 60 * 1000, Math.min(Number(ttlMs) || 48 * 3600 * 1000, 30 * 24 * 3600 * 1000))
  const now = Date.now()
  let code
  // 极小概率撞码时重试
  for (let i = 0; i < 5; i++) {
    code = genCode()
    if (!q1('SELECT code FROM farm_invites WHERE code=?', code)) break
  }
  run(`INSERT INTO farm_invites (code,farm_id,created_by,role,uses,max_uses,expires_at,created_at)
       VALUES (?,?,?,?,0,?,?,?)`, code, farmId, userId, grantRole, uses, now + ttl, now)
  return inviteView(q1('SELECT * FROM farm_invites WHERE code=?', code), { now })
}

export function listInvites(farmId) {
  const now = Date.now()
  return q('SELECT * FROM farm_invites WHERE farm_id=? ORDER BY created_at DESC', farmId).map((r) => inviteView(r, { now }))
}

function inviteView(r, { now = Date.now() } = {}) {
  const usedUp = r.uses >= r.max_uses
  const expired = now > r.expires_at
  return {
    code: r.code,
    role: r.role,
    uses: r.uses,
    maxUses: r.max_uses,
    revoked: !!r.revoked,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    valid: !r.revoked && !usedUp && !expired
  }
}

export function revokeInvite(farmId, code) {
  const r = run('UPDATE farm_invites SET revoked=1 WHERE farm_id=? AND code=?', farmId, code)
  if (!r.changes) throw Object.assign(new Error('邀请码不存在'), { status: 404 })
  return { ok: true }
}

// 凭邀请码加入（或回归）农场
export function joinByCode(userId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase()
  const inv = q1('SELECT * FROM farm_invites WHERE code=?', code)
  if (!inv || inv.farm_id == null) throw Object.assign(new Error('邀请码无效'), { status: 400 })
  const now = Date.now()
  if (inv.revoked) throw Object.assign(new Error('邀请码已被撤销'), { status: 400 })
  if (now > inv.expires_at) throw Object.assign(new Error('邀请码已过期'), { status: 400 })
  if (inv.uses >= inv.max_uses) throw Object.assign(new Error('邀请码使用次数已用完'), { status: 400 })

  db.exec('BEGIN IMMEDIATE')
  try {
    // 事务内重读，避免多端同时使用最后一个名额
    const cur = q1('SELECT * FROM farm_invites WHERE code=?', code)
    if (cur.revoked || now > cur.expires_at || cur.uses >= cur.max_uses) {
      throw Object.assign(new Error('邀请码已不可用'), { status: 400 })
    }
    const farm = q1('SELECT * FROM farms WHERE id=?', cur.farm_id)
    if (!farm || !farm.owner_id) throw Object.assign(new Error('农场不存在'), { status: 404 })
    const existing = q1('SELECT * FROM farm_members WHERE farm_id=? AND user_id=?', farm.id, userId)
    if (existing && existing.status === 'active') {
      throw Object.assign(new Error('你已经是该农场成员'), { status: 400 })
    }
    if (existing) {
      // 曾经退出的成员：凭有效邀请回归，恢复为邀请码指定角色
      run("UPDATE farm_members SET role=?, status='active', joined_at=?, left_at=NULL WHERE farm_id=? AND user_id=?",
        cur.role, now, farm.id, userId)
    } else {
      run("INSERT INTO farm_members (farm_id,user_id,role,status,joined_at) VALUES (?,?,?,'active',?)",
        farm.id, userId, cur.role, now)
    }
    run('UPDATE farm_invites SET uses=uses+1 WHERE code=?', code)
    db.exec('COMMIT')
    return { ok: true, farmId: farm.id, farmName: farm.name, role: cur.role, rejoined: !!existing }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束 */ }
    throw e
  }
}

// 农场成员清单（附在线状态由路由层合并）
export function listMembers(farmId) {
  return q(`SELECT m.user_id, u.name, m.role, m.status, m.joined_at, m.left_at
            FROM farm_members m JOIN users u ON u.id=m.user_id
            WHERE m.farm_id=? ORDER BY
              CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at`, farmId)
    .map((m) => ({
      userId: m.user_id, name: m.name, role: m.role, status: m.status,
      joinedAt: m.joined_at, leftAt: m.left_at
    }))
}

// 调整成员角色（member <-> admin；场主身份只能通过转让变更）
export function setMemberRole(farmId, actorUserId, targetUserId, role) {
  if (role !== 'member' && role !== 'admin') throw Object.assign(new Error('角色无效'), { status: 400 })
  if (targetUserId === actorUserId) throw Object.assign(new Error('不能修改自己的角色'), { status: 400 })
  const t = q1('SELECT * FROM farm_members WHERE farm_id=? AND user_id=?', farmId, targetUserId)
  if (!t) throw Object.assign(new Error('成员不存在'), { status: 404 })
  if (t.role === 'owner') throw Object.assign(new Error('不能修改场主角色'), { status: 400 })
  if (t.status !== 'active') throw Object.assign(new Error('该成员已退出农场'), { status: 400 })
  run('UPDATE farm_members SET role=? WHERE farm_id=? AND user_id=?', role, farmId, targetUserId)
  return { ok: true, role }
}

// 主动退出农场（场主不可直接退出，须先转让或解散）
export function leaveFarm(farmId, userId) {
  const m = q1("SELECT * FROM farm_members WHERE farm_id=? AND user_id=? AND status='active'", farmId, userId)
  if (!m) throw Object.assign(new Error('你不是该农场成员'), { status: 400 })
  if (m.role === 'owner') throw Object.assign(new Error('场主请先转让农场或解散农场'), { status: 400 })
  run("UPDATE farm_members SET status='left', left_at=?, role='member' WHERE farm_id=? AND user_id=?",
    Date.now(), farmId, userId)
  return { ok: true }
}

// 场主把农场转让给其他在团成员（自己降为管理员）
export function transferFarm(farmId, fromUserId, toUserId) {
  if (fromUserId === toUserId) throw Object.assign(new Error('目标不能是自己'), { status: 400 })
  const target = q1("SELECT * FROM farm_members WHERE farm_id=? AND user_id=? AND status='active'", farmId, toUserId)
  if (!target) throw Object.assign(new Error('目标成员不存在或已退出'), { status: 404 })
  db.exec('BEGIN IMMEDIATE')
  try {
    run("UPDATE farm_members SET role='admin' WHERE farm_id=? AND user_id=?", farmId, fromUserId)
    run("UPDATE farm_members SET role='owner' WHERE farm_id=? AND user_id=?", farmId, toUserId)
    run('UPDATE farms SET owner_id=? WHERE id=?', toUserId, farmId)
    db.exec('COMMIT')
    return { ok: true, ownerId: toUserId }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束 */ }
    throw e
  }
}

// 场主解散农场：删除全部存档数据与成员关系（id=1 旧单人存档禁止解散，只能邀请共营）
export function disbandFarm(farmId) {
  if (farmId === 1) throw Object.assign(new Error('初始农场不能解散（可邀请好友共营）'), { status: 400 })
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const t of FARM_TABLES) run('DELETE FROM ' + t + ' WHERE farm_id=?', farmId)
    run('DELETE FROM farm_members WHERE farm_id=?', farmId)
    run('DELETE FROM farm_invites WHERE farm_id=?', farmId)
    run('DELETE FROM player WHERE farm_id=?', farmId)
    run('DELETE FROM farms WHERE id=?', farmId)
    db.exec('COMMIT')
    return { ok: true }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束 */ }
    throw e
  }
}
