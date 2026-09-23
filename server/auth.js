import crypto from 'node:crypto'
import { db, roleCan } from './db.js'

const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

const TOKEN_TTL = 1000 * 60 * 60 * 24 * 365 // 本地存档：token 一年有效

function newToken() {
  return crypto.randomBytes(24).toString('base64url')
}

// 注册（名字不可重复）；已存在同名账号则直接报错由前端提示
export function createUser(name) {
  const clean = String(name || '').trim().slice(0, 16)
  if (!clean) throw Object.assign(new Error('请输入昵称'), { status: 400 })
  if (q1('SELECT id FROM users WHERE name=?', clean)) {
    throw Object.assign(new Error('昵称已被占用，换一个吧'), { status: 400 })
  }
  const r = run('INSERT INTO users (name,created_at) VALUES (?,?)', clean, Date.now())
  return loginUser(r.lastInsertRowid)
}

export function loginUser(userId) {
  const token = newToken()
  run('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)', token, userId, Date.now())
  return { token, user: publicUser(q1('SELECT * FROM users WHERE id=?', userId)) }
}

export function publicUser(u) {
  return u ? { id: u.id, name: u.name } : null
}

function sessionUser(token) {
  if (!token) return null
  const s = q1('SELECT * FROM sessions WHERE token=?', token)
  if (!s) return null
  if (Date.now() - s.created_at > TOKEN_TTL) {
    run('DELETE FROM sessions WHERE token=?', token)
    return null
  }
  return q1('SELECT * FROM users WHERE id=?', s.user_id)
}

// 取成员身份；农场未被认领（旧单人存档 id=1 且 owner_id 为空）时，
// 任何登录用户均可以 owner 视角只读预览；写操作会在 authContext 中被拦下要求先认领。
function membership(farmId, userId) {
  const farm = q1('SELECT * FROM farms WHERE id=?', farmId)
  if (!farm) return { farm: null, role: null, status: null, unclaimed: false }
  if (!farm.owner_id) return { farm, role: 'owner', status: 'active', unclaimed: true }
  const m = q1('SELECT * FROM farm_members WHERE farm_id=? AND user_id=?', farmId, userId)
  if (m && m.status === 'active') return { farm, role: m.role, status: m.status, unclaimed: false }
  return { farm, role: null, status: m?.status || null, unclaimed: false }
}

// 原子认领：UPDATE...WHERE owner_id IS NULL 保证并发时只有一人成功
export function claimIfNeeded(farmId, userId) {
  const before = q1('SELECT owner_id FROM farms WHERE id=?', farmId)
  if (!before || before.owner_id) return false
  const r = run('UPDATE farms SET owner_id=? WHERE id=? AND owner_id IS NULL', userId, farmId)
  if (r.changes) {
    run("INSERT OR IGNORE INTO farm_members (farm_id,user_id,role,status,joined_at) VALUES (?,?, 'owner','active',?)",
      farmId, userId, Date.now())
  }
  return true
}

// Express 中间件：解析 token + X-Farm-Id，挂到 req.ctx = { user, farm, farmId, role, unclaimed }
// 未认领的旧农场只允许只读预览；写操作必须先经 /me 或 /coop/claim 完成认领（非成员不能靠写操作抢占）
export function authContext(req, res, next) {
  const token = req.get('X-Auth-Token')
  const user = sessionUser(token)
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' })
  const farmId = Math.max(1, Math.floor(Number(req.get('X-Farm-Id')) || 1))
  const isWrite = req.method !== 'GET' && req.method !== 'HEAD'
  const ctx = membership(farmId, user.id)
  if (!ctx.farm) return res.status(404).json({ error: '农场不存在' })
  // 写操作时农场仍未认领：拒绝并要求先认领，杜绝非成员借写操作抢占旧存档
  if (isWrite && ctx.unclaimed) {
    return res.status(428).json({ error: 'unclaimed', message: '请先认领旧农场后再操作' })
  }
  if (!ctx.role) {
    return res.status(403).json({ error: ctx.status === 'left' ? '你已退出该农场' : '你不是该农场成员' })
  }
  req.ctx = { user, farm: ctx.farm, farmId, role: ctx.role, unclaimed: ctx.unclaimed }
  next()
}

// 轻量鉴权：只校验登录态（创建农场、凭邀请码加入等「尚无农场身份」的接口用）
export function authUser(req, res, next) {
  const user = sessionUser(req.get('X-Auth-Token'))
  if (!user) return res.status(401).json({ error: '未登录或登录已过期' })
  req.ctx = { user }
  next()
}

// 权限校验中间件工厂
export function requirePerm(perm) {
  return (req, res, next) => {
    if (!roleCan(req.ctx.role, perm)) {
      return res.status(403).json({ error: '权限不足：该操作需要管理员或场主' })
    }
    next()
  }
}

// SSE 也走 query 参数（EventSource 无法设置请求头）
export function contextFromQuery(token, farmIdRaw) {
  const user = sessionUser(token)
  if (!user) return null
  const farmId = Math.max(1, Math.floor(Number(farmIdRaw) || 1))
  const ctx = membership(farmId, user.id)
  if (!ctx.farm || !ctx.role) return null
  return { user, farm: ctx.farm, farmId, role: ctx.role, unclaimed: ctx.unclaimed }
}

// 列出用户加入的农场（含已退出的状态，前端只默认展示 active）
export function listUserFarms(userId) {
  return db.prepare(`
    SELECT f.id, f.name, f.owner_id, f.version, m.role, m.status,
           (SELECT COUNT(*) FROM farm_members fm WHERE fm.farm_id=f.id AND fm.status='active') AS member_count
    FROM farm_members m JOIN farms f ON f.id=m.farm_id
    WHERE m.user_id=? ORDER BY (m.status='active') DESC, f.id`).all(userId)
}

// 认领旧单人存档的原子实现见 claimIfNeeded（coop.claimFarm1 与 /me 复用）

export { sessionUser, membership }
