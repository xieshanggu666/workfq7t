// ===== 实时协作服务（SSE 发布订阅 + 在线成员）=====
// 同进程内按农场维护 SSE 连接集合：任何成员的写操作提交后，
// 向该农场全体连接推送 mutation/change，客户端收到后重拉状态，保证多端最终一致。
const clients = new Map() // farmId -> Set<res>
const presence = new Map() // farmId -> Map<userId, {name, count}>
const farmLocks = new Map() // farmId -> Promise 串行化推进时间等重事务

export function addClient(farmId, res) {
  if (!clients.has(farmId)) clients.set(farmId, new Set())
  clients.get(farmId).add(res)
}
export function removeClient(farmId, res) {
  clients.get(farmId)?.delete(res)
}

// 农场变更广播：data 携带动作类型、版本、触发者，在线端据此决定是否静默重拉
export function broadcast(farmId, data) {
  const set = clients.get(farmId)
  if (!set) return
  const payload = `data: ${JSON.stringify(data)}\n\n`
  for (const res of set) {
    try { res.write(payload) } catch { /* 连接可能已关闭，由 close 事件清理 */ }
  }
}

// ===== 在线成员（同一用户多标签页计为一人）=====
export function joinPresence(farmId, user) {
  if (!presence.has(farmId)) presence.set(farmId, new Map())
  const m = presence.get(farmId)
  const cur = m.get(user.id) || { name: user.name, count: 0 }
  cur.count += 1
  cur.name = user.name
  m.set(user.id, cur)
  sendPresence(farmId)
}
export function leavePresence(farmId, user) {
  const m = presence.get(farmId)
  if (!m) return
  const cur = m.get(user.id)
  if (!cur) return
  cur.count -= 1
  if (cur.count <= 0) m.delete(user.id)
  else m.set(user.id, cur)
  sendPresence(farmId)
}
export function onlineUsers(farmId) {
  const m = presence.get(farmId)
  return m ? [...m.entries()].map(([id, v]) => ({ id, name: v.name })) : []
}
function sendPresence(farmId) {
  broadcast(farmId, { type: 'presence', users: onlineUsers(farmId) })
}

// ===== 农场级互斥：推进时间（天气/灌溉/生产/育种多系统联合结算）
// 串行执行，杜绝同一农场两个并发 +1天 事务交错；跨农场互不阻塞。
export function withFarmLock(farmId, fn) {
  const prev = farmLocks.get(farmId) || Promise.resolve()
  let release
  const next = new Promise((r) => { release = r })
  farmLocks.set(farmId, prev.then(() => next))
  return prev.then(fn).finally(release)
}

// 心跳保活（代理默认超时）
export function setupHeartbeat(res) {
  return setInterval(() => {
    try { res.write(': ping\n\n') } catch { /* ignore */ }
  }, 25000)
}
