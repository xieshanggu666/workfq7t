import express from 'express'
import { db } from './db.js'
import { ensureLegacySeed } from './seed.js'
import { TYPES, ensureWeather, settleWeather, currentWeather } from './weather.js'
import {
  RECIPES, capacity, listJobs, queuedBatches, reservedStock,
  settleProduction, enqueueJob, cancelJob, reorderJob, collectJobs
} from './production.js'
import {
  COSTS as IRR_COSTS, RESERVOIR_CAP, networkInfo, computeNetworks, lastReport,
  settleIrrigation, buildFacility, toggleFacility, demolishFacility
} from './irrigation.js'
import {
  TRAITS, BREED_GOLD, breedCapacity,
  cropLike, listTrials, startTrial, careTrial, cancelTrial, settleBreeding
} from './breeding.js'
import {
  createUser, publicUser, authContext, authUser, requirePerm,
  contextFromQuery, listUserFarms, claimIfNeeded
} from './auth.js'
import {
  createFarm, claimFarm1, createInvite, listInvites, revokeInvite, joinByCode,
  listMembers, setMemberRole, leaveFarm, transferFarm, disbandFarm
} from './coop.js'
import {
  addClient, removeClient, broadcast, joinPresence, leavePresence,
  onlineUsers, withFarmLock, setupHeartbeat
} from './realtime.js'

const app = express()
app.use(express.json())

// ===== 首次启动：旧单人存档（farm 1）补齐初始数据 =====
ensureLegacySeed()

// ===== 通用查询辅助 =====
const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 兼容旧存档：补插育种棚（按农场；id 固定为 5，与 seed.js 的初始建筑顺序一致）
for (const f of q('SELECT id FROM farms')) {
  if (!q1('SELECT id FROM buildings WHERE farm_id=? AND name=?', f.id, '育种棚')) {
    run('INSERT INTO buildings (farm_id,id,name,level,x,y,desc) VALUES (?,?,?,?,?,?,?)',
      f.id, 5, '育种棚', 1, 10, 7, '杂交育种：投入两批作物培育带遗传性状的新品种')
  }
}

// 启动时确保各农场当天天气已生成（兼容旧存档）
for (const p0 of q('SELECT * FROM player')) {
  ensureWeather(p0.season, p0.day, p0.abs_day, p0.farm_id)
}

// ===== 账号（无鉴权）=====
// 注册并直接登录，返回 token；昵称重名时 400
app.post('/api/register', (req, res) => {
  try {
    const { token, user } = createUser(req.body?.name)
    res.json({ token, user })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 登录态恢复：token 有效时返回用户与农场清单；并尝试自动认领旧单人存档
app.get('/api/me', (req, res) => {
  const token = req.get('X-Auth-Token')
  const s = q1('SELECT * FROM sessions WHERE token=?', token)
  if (!s) return res.status(401).json({ error: '未登录' })
  const user = q1('SELECT * FROM users WHERE id=?', s.user_id)
  if (!user) return res.status(401).json({ error: '用户不存在' })
  // 旧单人存档尚未被任何人认领时，首个 /me 的玩家原子认领成为场主（并发安全）
  const farm1 = q1('SELECT owner_id FROM farms WHERE id=1')
  if (farm1 && !farm1.owner_id) claimIfNeeded(1, user.id)
  res.json({ user: publicUser(user), farms: listUserFarms(user.id) })
})

// ===== 共营农场管理 =====
// 创建农场（任何已登录用户；不需要当前农场成员身份）
app.post('/api/coop/farms', authUser, (req, res) => {
  try {
    const f = createFarm(req.ctx.user.id, req.body?.name)
    res.json({ ok: true, farm: f })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 主动认领旧单人存档（登录即可，认领本身正是「从未认领变为场主」的动作，故用 authUser）
app.post('/api/coop/claim', authUser, (req, res) => {
  res.json(claimFarm1(req.ctx.user.id))
})

// 凭邀请码加入农场（加入者此时还不是成员，只需登录态）
app.post('/api/coop/join', authUser, (req, res) => {
  try {
    res.json(joinByCode(req.ctx.user.id, req.body?.code))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 农场详情：成员、邀请码、在线成员
app.get('/api/coop/farms/:id', authContext, (req, res) => {
  const fid = Number(req.params.id)
  if (fid !== req.ctx.farmId) return res.status(403).json({ error: '无权查看该农场' })
  res.json({
    farm: req.ctx.farm,
    role: req.ctx.role,
    unclaimed: req.ctx.unclaimed,
    members: listMembers(fid).map((m) => ({ ...m, online: onlineUsers(fid).some((u) => u.id === m.userId) })),
    invites: listInvites(fid),
    online: onlineUsers(fid),
    me: publicUser(req.ctx.user)
  })
})

// 退出农场（成员/管理员）
app.post('/api/coop/leave', authContext, (req, res) => {
  try {
    res.json(leaveFarm(req.ctx.farmId, req.ctx.user.id))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 创建邀请码（管理员+）
app.post('/api/coop/invites', authContext, requirePerm('inviteCreate'), (req, res) => {
  try {
    const inv = createInvite(req.ctx.farmId, req.ctx.user.id, {
      role: req.body?.role === 'admin' ? 'admin' : 'member',
      maxUses: req.body?.maxUses,
      ttlMs: req.body?.ttlMs
    })
    res.json({ ok: true, invite: inv })
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 撤销邀请码（管理员+）
app.post('/api/coop/invites/revoke', authContext, requirePerm('inviteRevoke'), (req, res) => {
  try {
    res.json(revokeInvite(req.ctx.farmId, req.body?.code))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 调整成员角色（场主）
app.post('/api/coop/members/role', authContext, requirePerm('memberRole'), (req, res) => {
  try {
    res.json(setMemberRole(req.ctx.farmId, req.ctx.user.id, Number(req.body?.userId), String(req.body?.role || '')))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 转让农场（场主）
app.post('/api/coop/transfer', authContext, requirePerm('transfer'), (req, res) => {
  try {
    res.json(transferFarm(req.ctx.farmId, req.ctx.user.id, Number(req.body?.userId)))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
})

// 解散农场（场主，farm 1 除外）
app.post('/api/coop/disband', authContext, requirePerm('disband'), (req, res) => {
  const fid = req.ctx.farmId
  try {
    res.json(disbandFarm(fid))
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message })
  }
  // 通知所有在线连接农场已解散（响应后）
  setTimeout(() => broadcast(fid, { type: 'disbanded', at: Date.now() }), 0)
})

// ===== 实时协作通道：SSE =====
app.get('/api/events', (req, res) => {
  const ctx = contextFromQuery(req.query.token, req.query.farmId)
  if (!ctx) return res.status(401).end()
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })
  res.write('retry: 3000\n\n')
  addClient(ctx.farmId, res)
  joinPresence(ctx.farmId, ctx.user)
  // 连上后先推一次在线列表与版本，便于客户端对齐
  res.write(`data: ${JSON.stringify({ type: 'hello', version: ctx.farm.version, users: onlineUsers(ctx.farmId) })}\n\n`)
  const hb = setupHeartbeat(res)
  req.on('close', () => {
    clearInterval(hb)
    removeClient(ctx.farmId, res)
    leavePresence(ctx.farmId, ctx.user)
  })
})

// ===== 状态版本：乐观并发控制 + 实时广播 =====
function currentVersion(farmId) {
  return q1('SELECT version FROM farms WHERE id=?', farmId)?.version || 0
}
function bumpVersion(farmId) {
  run('UPDATE farms SET version=version+1 WHERE id=?', farmId)
  return currentVersion(farmId)
}

// 变更接口统一包装：
//  1) 乐观版本检查：客户端携带 X-State-Version，落后则 409（多端并发一致）
//  2) 执行落库；成功后农场版本 +1，并向其他在线端广播 mutation
function mutate(perm, action, handler) {
  return [authContext, requirePerm(perm), async (req, res) => {
    const fid = req.ctx.farmId
    const clientVersion = Number(req.get('X-State-Version'))
    if (Number.isFinite(clientVersion) && clientVersion !== currentVersion(fid)) {
      return res.status(409).json({ error: 'state_stale', version: currentVersion(fid) })
    }
    let result
    try {
      result = await handler(req, res)
    } catch (e) {
      if (!res.headersSent) res.status(e.status || 500).json({ error: e.message })
      return
    }
    if (res.headersSent) return
    const version = bumpVersion(fid)
    broadcast(fid, {
      type: 'mutation', action, version,
      clientId: req.get('X-Client-Id') || null,
      by: { id: req.ctx.user.id, name: req.ctx.user.name }, at: Date.now()
    })
    res.json({ ok: true, version, ...(result || {}) })
  }]
}

// ===== 游戏状态 =====
app.get('/api/state', authContext, (req, res) => {
  const fid = req.ctx.farmId
  const p = q1('SELECT * FROM player WHERE farm_id=?', fid)
  const mill = q1('SELECT * FROM buildings WHERE farm_id=? AND id=2', fid)
  const lab = q1('SELECT * FROM buildings WHERE farm_id=? AND name=?', fid, '育种棚')
  // 供水网络：连通且启用中的地块/水渠（前端绘制供水状态用）
  const nets = computeNetworks(fid)
  const net = networkInfo(nets)
  res.json({
    version: req.ctx.farm.version,
    role: req.ctx.role,
    unclaimed: req.ctx.unclaimed,
    me: publicUser(req.ctx.user),
    farm: { id: req.ctx.farm.id, name: req.ctx.farm.name },
    online: onlineUsers(fid),
    player: p,
    crops: q('SELECT * FROM crops WHERE farm_id=?', fid),
    varieties: q('SELECT * FROM crop_varieties WHERE farm_id=? ORDER BY id', fid)
      .map((v) => ({ ...v, traits: JSON.parse(v.traits || '[]') })),
    inventory: q('SELECT * FROM inventory WHERE farm_id=?', fid),
    buildings: q('SELECT * FROM buildings WHERE farm_id=?', fid),
    animals: q('SELECT * FROM animals WHERE farm_id=?', fid),
    plots: q('SELECT * FROM plots WHERE farm_id=?', fid).map((pl) => ({ ...pl, irrigated: net.plotIds.has(pl.id) })),
    weather: currentWeather(fid),
    weatherLog: q('SELECT * FROM weather_log WHERE farm_id=? ORDER BY id DESC LIMIT 8', fid),
    recipes: RECIPES,
    queueCapacity: capacity(mill?.level || 1),
    queuedBatches: queuedBatches(p.abs_day, fid),
    // 协作排产：在制工单占用（已投料）的原料汇总，前端区分「空闲库存 / 被队列占用」
    productionReserved: reservedStock(p.abs_day, fid),
    productionJobs: listJobs(p.abs_day, fid),
    breeding: {
      trials: listTrials(fid),
      traits: TRAITS,
      capacity: breedCapacity(lab?.level || 1),
      running: q1("SELECT COUNT(*) c FROM breeding_trials WHERE farm_id=? AND status='running'", fid).c,
      goldCost: BREED_GOLD,
      labId: lab?.id || null,
      labLevel: lab?.level || 1
    },
    irrigation: q('SELECT * FROM irrigation WHERE farm_id=?', fid).map((f) => ({
      ...f,
      cap: f.kind === 'reservoir' ? RESERVOIR_CAP : null,
      linked: f.kind === 'canal' ? net.canalIds.has(f.id) : !!f.active
    })),
    irrigationCosts: IRR_COSTS,
    // 供水网络概览（多座蓄水池连通时统一分水）+ 最近一次每日分配结果（缺水时展示明细）
    irrigationNetworks: nets.filter((n) => n.reservoirs.length).map((n) => ({
      id: n.id, reservoirs: n.reservoirs.length, canals: n.canalIds.length,
      plots: n.plotIds.size, water: n.water, cap: n.cap
    })),
    irrigationReport: lastReport(fid)
  })
})

// 播种：plotId + cropId（<1000 基础作物，>=1000 杂交品种）
app.post('/api/plant', ...mutate('plant', 'plant', (req) => {
  const fid = req.ctx.farmId
  const { plotId, cropId } = req.body
  const plot = q1('SELECT * FROM plots WHERE farm_id=? AND id=?', fid, plotId)
  const crop = cropLike(fid, cropId)
  if (!plot || !crop) throw Object.assign(new Error('not found'), { status: 404 })
  if (plot.crop_id) throw Object.assign(new Error('already planted'), { status: 400 })
  const seedId = crop.isVariety ? 'seed-v' + crop.id : 'seed-' + crop.id
  const invById = q1('SELECT qty FROM inventory WHERE farm_id=? AND item_id=?', fid, seedId)
  const stock = invById?.qty || 0
  if (stock <= 0) throw Object.assign(new Error('no seed'), { status: 400 })
  run(`UPDATE plots SET crop_id=?, stage=0, water=100, fert=100, light=100, pest=0,
       planted_day=(SELECT day FROM player WHERE farm_id=?),
       planted_season=(SELECT season FROM player WHERE farm_id=?)
       WHERE farm_id=? AND id=?`, crop.id, fid, fid, fid, plot.id)
  run('UPDATE inventory SET qty=qty-1 WHERE farm_id=? AND item_id=?', fid, seedId)
  cleanEmpty(fid)
}))

// 浇水
app.post('/api/water', ...mutate('water', 'water', (req) => {
  run('UPDATE plots SET water=100 WHERE farm_id=? AND id=?', req.ctx.farmId, req.body.plotId)
}))

// 施肥
app.post('/api/fertilize', ...mutate('fertilize', 'fertilize', (req) => {
  run('UPDATE plots SET fert=100 WHERE farm_id=? AND id=?', req.ctx.farmId, req.body.plotId)
}))

// 除草/除虫
app.post('/api/clean', ...mutate('clean', 'clean', (req) => {
  run('UPDATE plots SET pest=0 WHERE farm_id=? AND id=?', req.ctx.farmId, req.body.plotId)
}))

// 收获：返回作物，给钱（若成熟）；品种按遗传性状结算产量与售价
app.post('/api/harvest', ...mutate('harvest', 'harvest', (req) => {
  const fid = req.ctx.farmId
  const { plotId } = req.body
  const plot = q1('SELECT * FROM plots WHERE farm_id=? AND id=?', fid, plotId)
  if (!plot || !plot.crop_id) throw Object.assign(new Error('empty'), { status: 404 })
  const crop = cropLike(fid, plot.crop_id)
  if (!crop) throw Object.assign(new Error('crop missing'), { status: 404 })
  const isFullGrown = plot.stage >= (crop.days - 1)
  if (!isFullGrown) throw Object.assign(new Error('not grown'), { status: 400 })
  // 产量：基础 1；高产 +1、低产 -1（保底 1）
  let yieldN = 1
  if (crop.isVariety) {
    for (const k of crop.traits) {
      const m = TRAITS[k]?.mods || {}
      if (m.harvestYield) yieldN += m.harvestYield
    }
  }
  yieldN = Math.max(1, yieldN)
  const gain = crop.price * yieldN
  run('UPDATE player SET gold=gold+?, exp=exp+? WHERE farm_id=?', gain, 3, fid)
  // 得到作物 + 概率得同种种子
  const cropItemId = crop.isVariety ? 'crop-v' + crop.id : 'crop-' + crop.id
  const seedItemId = crop.isVariety ? 'seed-v' + crop.id : 'seed-' + crop.id
  addInv(fid, cropItemId, crop.name, 'crop', yieldN)
  if (Math.random() < 0.25) addInv(fid, seedItemId, crop.name + '种子', 'seed', 1)
  run(`UPDATE plots SET crop_id=NULL, stage=-1, water=100, fert=100, light=100, pest=0,
       planted_day=NULL, planted_season=NULL WHERE farm_id=? AND id=?`, fid, plotId)
  return { yield: crop.name, qty: yieldN, gold: gain, variety: crop.isVariety }
}))

// 时间推进（管理员+）：连续跳日逐天结算；农场级互斥串行，杜绝并发结算
function skipDaysRoute(req) {
  const fid = req.ctx.farmId
  const n = Math.min(Math.max(1, Number(req.body?.n) || 1), 14)
  const clientVersion = Number(req.get('X-State-Version'))
  // withFarmLock 返回 Promise；拿到锁后再次校验版本，避免排队期间被其他端抢先结算
  return withFarmLock(fid, () => {
    if (Number.isFinite(clientVersion) && clientVersion !== currentVersion(fid)) {
      throw Object.assign(new Error('state_stale'), { status: 409 })
    }
    const logs = []
    for (let i = 0; i < n; i++) logs.push(...advanceDay(fid))
    return { logs }
  })
}
app.post('/api/nextday', ...mutate('nextday', 'nextday', skipDaysRoute))
app.post('/api/skip', ...mutate('nextday', 'nextday', skipDaysRoute))

// 投入金币/物资防灾（作用于当前未结束的天气事件）
app.post('/api/weather/protect', ...mutate('protect', 'protect', (req) => {
  const fid = req.ctx.farmId
  const gold = Math.max(0, Math.min(Math.floor(Number(req.body?.gold) || 0), 500))
  const matQty = Math.max(0, Math.min(Math.floor(Number(req.body?.matQty) || 0), 99))
  if (!gold && !matQty) throw Object.assign(new Error('未投入任何资源'), { status: 400 })
  const ev = q1('SELECT * FROM weather_events WHERE farm_id=? AND done=0 ORDER BY abs_day LIMIT 1', fid)
  if (!ev || !TYPES[ev.type]?.bad) throw Object.assign(new Error('当前天气无需防护'), { status: 400 })
  db.exec('BEGIN IMMEDIATE')
  try {
    const p = q1('SELECT gold FROM player WHERE farm_id=?', fid)
    if (p.gold < gold) throw Object.assign(new Error('金币不足'), { status: 400 })
    if (matQty > 0) {
      const stacks = q("SELECT * FROM inventory WHERE farm_id=? AND cat='material' AND qty>0 ORDER BY qty DESC", fid)
      const total = stacks.reduce((s, r) => s + r.qty, 0)
      if (total < matQty) throw Object.assign(new Error('物资不足'), { status: 400 })
      let need = matQty
      for (const s of stacks) {
        const take = Math.min(need, s.qty)
        run('UPDATE inventory SET qty=qty-? WHERE id=?', take, s.id)
        need -= take
        if (!need) break
      }
    }
    run('UPDATE player SET gold=gold-? WHERE farm_id=?', gold, fid)
    run('UPDATE weather_events SET protect_gold=protect_gold+?, protect_mat=protect_mat+? WHERE id=?', gold, matQty, ev.id)
    cleanEmpty(fid)
    db.exec('COMMIT')
    return { protect_gold: ev.protect_gold + gold, protect_mat: ev.protect_mat + matQty }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}))

// 购买防灾物资
app.post('/api/buymat', ...mutate('buymat', 'buymat', (req) => {
  const fid = req.ctx.farmId
  const n = Math.max(1, Math.min(Number(req.body?.qty) || 1, 99))
  const cost = 12 * n
  const p = q1('SELECT gold FROM player WHERE farm_id=?', fid)
  if (p.gold < cost) throw Object.assign(new Error('no gold'), { status: 400 })
  run('UPDATE player SET gold=gold-? WHERE farm_id=?', cost, fid)
  addInv(fid, 'disaster-kit', '防灾物资', 'material', n)
}))

// 买种子
app.post('/api/buyseed', ...mutate('buyseed', 'buyseed', (req) => {
  const fid = req.ctx.farmId
  const { cropId, qty } = req.body
  const n = Math.max(1, Math.min(Number(qty) || 1, 99))
  const crop = q1('SELECT * FROM crops WHERE farm_id=? AND id=?', fid, cropId)
  if (!crop) throw Object.assign(new Error('crop'), { status: 404 })
  const cost = crop.seedPrice * n
  const p = q1('SELECT gold FROM player WHERE farm_id=?', fid)
  if (p.gold < cost) throw Object.assign(new Error('no gold'), { status: 400 })
  run('UPDATE player SET gold=gold-? WHERE farm_id=?', cost, fid)
  addInv(fid, 'seed-' + crop.id, crop.name + '种子', 'seed', n)
}))

// 卖作物（兼容杂交品种：cropId>=1000 走品种库存与价格）
app.post('/api/sellcrop', ...mutate('sellcrop', 'sellcrop', (req) => {
  const fid = req.ctx.farmId
  const { cropId, qty } = req.body
  const n = Math.max(1, Math.min(Number(qty) || 1, 999))
  const crop = cropLike(fid, cropId)
  if (!crop) throw Object.assign(new Error('crop'), { status: 404 })
  const itemId = crop.isVariety ? 'crop-v' + crop.id : 'crop-' + crop.id
  const hold = q1('SELECT qty FROM inventory WHERE farm_id=? AND item_id=?', fid, itemId)
  const stock = hold?.qty || 0
  const s = Math.min(n, stock)
  if (s <= 0) throw Object.assign(new Error('none'), { status: 400 })
  const gain = crop.price * s
  run('UPDATE inventory SET qty=qty-? WHERE farm_id=? AND item_id=?', s, fid, itemId)
  run('UPDATE player SET gold=gold+? WHERE farm_id=?', gain, fid)
  cleanEmpty(fid)
  return { gain, sold: s }
}))

// 领养动物
app.post('/api/animal', ...mutate('adopt', 'adopt', (req) => {
  const fid = req.ctx.farmId
  const { species } = req.body
  const cfg = { chicken: { name: '母鸡', cost: 30 }, cow: { name: '奶牛', cost: 80 }, sheep: { name: '绵羊', cost: 60 } }
  const c = cfg[species]
  if (!c) throw Object.assign(new Error('species'), { status: 400 })
  const p = q1('SELECT gold FROM player WHERE farm_id=?', fid)
  if (p.gold < c.cost) throw Object.assign(new Error('no gold'), { status: 400 })
  run('UPDATE player SET gold=gold-? WHERE farm_id=?', c.cost, fid)
  const x = 8 + (q1('SELECT COUNT(*) c FROM animals WHERE farm_id=?', fid).c) % 3
  const r = run('INSERT INTO animals (farm_id,name,species,x,y) VALUES (?,?,?,?,?)',
    fid, c.name + '#' + (Date.now() % 1000), species, x, 8)
  return { id: r.lastInsertRowid }
}))

// 喂食
app.post('/api/feed', ...mutate('feed', 'feed', (req) => {
  run('UPDATE animals SET feed=100 WHERE farm_id=? AND id=?', req.ctx.farmId, req.body.id)
}))

// 收集动物产物
app.post('/api/collect', ...mutate('collect', 'collect', (req) => {
  const fid = req.ctx.farmId
  const a = q1('SELECT * FROM animals WHERE farm_id=? AND id=?', fid, req.body.id)
  if (!a || !a.ready) throw Object.assign(new Error('not ready'), { status: 400 })
  const prod = { chicken: ['鸡蛋', 6], cow: ['牛奶', 12], sheep: ['羊毛', 10] }[a.species]
  addInv(fid, 'p-' + a.species, prod[0], 'product', 1)
  const gain = Math.round(prod[1] / 2)
  run('UPDATE player SET gold=gold+? WHERE farm_id=?', gain, fid)
  run('UPDATE animals SET ready=0 WHERE id=?', a.id)
  return { item: prod[0], gold: gain }
}))

// ===== 加工生产队列 =====
// 批量排产：recipeId + qty（批次数），记录排产人用于协作追踪与权限边界
app.post('/api/production/enqueue', ...mutate('enqueue', 'production/enqueue', (req) => {
  const fid = req.ctx.farmId
  const p = q1('SELECT * FROM player WHERE farm_id=?', fid)
  const mill = q1('SELECT level FROM buildings WHERE farm_id=? AND id=2', fid)
  return enqueueJob({
    recipeId: req.body.recipeId,
    qty: Number(req.body.qty) || 1,
    millLevel: mill?.level || 1,
    currentAbs: p.abs_day,
    farmId: fid,
    userId: req.ctx.user.id,
    userName: req.ctx.user.name
  })
}))

// 取消工单：退未开工批次的原料（只能取消自己排产的，管理员可取消任意工单）
app.post('/api/production/cancel', ...mutate('cancelJob', 'production/cancel', (req) => {
  const fid = req.ctx.farmId
  const p = q1('SELECT abs_day FROM player WHERE farm_id=?', fid)
  return cancelJob({
    id: Number(req.body?.id), currentAbs: p.abs_day, farmId: fid,
    userId: req.ctx.user.id, role: req.ctx.role
  })
}))

// 队列重排：未开工工单上移/下移一位，已开工工单钉死不动
app.post('/api/production/reorder', ...mutate('reorderJob', 'production/reorder', (req) => {
  const fid = req.ctx.farmId
  const p = q1('SELECT abs_day FROM player WHERE farm_id=?', fid)
  return reorderJob({
    id: Number(req.body?.id), dir: Number(req.body?.dir),
    currentAbs: p.abs_day, farmId: fid
  })
}))

// 完工入库：传 id 领单个，不传则一键全领
app.post('/api/production/collect', ...mutate('collectJob', 'production/collect', (req) => {
  const fid = req.ctx.farmId
  const p = q1('SELECT abs_day FROM player WHERE farm_id=?', fid)
  return collectJobs(p.abs_day, fid, req.body?.id != null ? Number(req.body.id) : null)
}))

// ===== 灌溉系统 =====
// 建造蓄水池/水渠（管理员+）：kind + 坐标，扣金币
app.post('/api/irrigation/build', ...mutate('irrigBuild', 'irrigation/build', (req) => {
  const { kind, x, y } = req.body || {}
  return buildFacility(req.ctx.farmId, kind, Number(x), Number(y))
}))

// 停用/启用：停用即断流，启用后恢复供水
app.post('/api/irrigation/toggle', ...mutate('irrigToggle', 'irrigation/toggle', (req) => {
  return toggleFacility(req.ctx.farmId, Number(req.body?.id))
}))

// 拆除（管理员+）：返还部分造价，蓄水池余水作废
app.post('/api/irrigation/demolish', ...mutate('irrigDemolish', 'irrigation/demolish', (req) => {
  return demolishFacility(req.ctx.farmId, Number(req.body?.id))
}))

// 设置地块灌溉优先级（0低 1中 2高）
app.post('/api/irrigation/priority', ...mutate('irrigPriority', 'irrigation/priority', (req) => {
  const fid = req.ctx.farmId
  const plotId = Number(req.body?.plotId)
  const priority = Math.max(0, Math.min(2, Math.floor(Number(req.body?.priority) || 0)))
  if (!q1('SELECT id FROM plots WHERE farm_id=? AND id=?', fid, plotId)) throw Object.assign(new Error('not found'), { status: 404 })
  run('UPDATE plots SET irr_priority=? WHERE id=?', priority, plotId)
  return { priority }
}))

// 设置地块目标水分（0~100，灌溉时浇到该水位为止；0 表示不自动浇水）
app.post('/api/irrigation/target', ...mutate('irrigTarget', 'irrigation/target', (req) => {
  const fid = req.ctx.farmId
  const plotId = Number(req.body?.plotId)
  const target = Math.max(0, Math.min(100, Math.floor(Number(req.body?.target) || 0)))
  if (!q1('SELECT id FROM plots WHERE farm_id=? AND id=?', fid, plotId)) throw Object.assign(new Error('not found'), { status: 404 })
  run('UPDATE plots SET irr_target=? WHERE id=?', target, plotId)
  return { target }
}))

// ===== 杂交育种 =====
// 开始试验（管理员+）：两批作物 parentA/parentB，格式 base:<id> 或 var:<id>
app.post('/api/breeding/start', ...mutate('breedStart', 'breeding/start', (req) => {
  const fid = req.ctx.farmId
  const lab = q1("SELECT level FROM buildings WHERE farm_id=? AND name='育种棚'", fid)
  const p = q1('SELECT abs_day FROM player WHERE farm_id=?', fid)
  return startTrial({
    parentA: String(req.body?.parentA || ''),
    parentB: String(req.body?.parentB || ''),
    labLevel: lab?.level || 1,
    currentAbs: p.abs_day,
    farmId: fid
  })
}))

// 养护试验：water 浇水 / fert 施肥 / tend 照料
app.post('/api/breeding/care', ...mutate('careTrial', 'breeding/care', (req) => {
  return careTrial(req.ctx.farmId, Number(req.body?.id), String(req.body?.action || ''))
}))

// 取消试验（亲本不退）
app.post('/api/breeding/cancel', ...mutate('cancelTrial', 'breeding/cancel', (req) => {
  return cancelTrial(req.ctx.farmId, Number(req.body?.id))
}))

// 升级建筑（场主）
app.post('/api/upgrade', ...mutate('upgrade', 'upgrade', (req) => {
  const fid = req.ctx.farmId
  const { id } = req.body
  const b = q1('SELECT * FROM buildings WHERE farm_id=? AND id=?', fid, id)
  if (!b || b.level >= 5) throw Object.assign(new Error('max'), { status: 400 })
  const cost = 40 * b.level
  if (q1('SELECT gold FROM player WHERE farm_id=?', fid).gold < cost) throw Object.assign(new Error('no gold'), { status: 400 })
  run('UPDATE player SET gold=gold-? WHERE farm_id=?', cost, fid)
  run('UPDATE buildings SET level=level+1 WHERE farm_id=? AND id=?', fid, id)
  return { level: b.level + 1 }
}))

// ===== 工具函数 =====
function addInv(farmId, itemId, name, cat, n) {
  const row = q1('SELECT id, qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)
  if (row) run('UPDATE inventory SET qty=qty+? WHERE id=?', n, row.id)
  else run('INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (?,?,?,?,?)', farmId, itemId, name, cat, n)
}
function cleanEmpty(farmId) {
  run('DELETE FROM inventory WHERE farm_id=? AND qty<=0', farmId)
}
function clamp100(v) { return Math.max(0, Math.min(100, v)) }

// 推进 1 天：事务内完成「天气结算 → 地块/动物逐日更新 → 日期推进 → 生成次日天气」，
// 任一步失败整体回滚，读档或重试不会重复扣损。返回当日天气结算日志。
// 外层 withFarmLock 已保证同一农场串行，跨农场仍可并发。
function advanceDay(farmId) {
  const logs = []
  db.exec('BEGIN IMMEDIATE')
  try {
    const p = q1('SELECT * FROM player WHERE farm_id=?', farmId)
    let { day, season } = p
    // —— 天气：结算当日事件（防护消耗/损失/恢复按天结算，幂等）——
    const { mods, logs: wlogs, type: wType, severity: wSev } = settleWeather(p.abs_day, farmId)
    logs.push(...wlogs)
    day += 1
    // 更新所有地块：生长 + 四维变化 + 虫害 + 天气修正（杂交品种性状参与结算）
    const plots = q('SELECT * FROM plots WHERE farm_id=?', farmId)
    for (const pl of plots) {
      if (!pl.crop_id) continue
      const crop = cropLike(farmId, pl.crop_id)
      if (!crop) continue
      const tset = new Set(crop.isVariety ? crop.traits : [])
      const traitMul = (k, f) => (tset.has(k) ? f : 1)
      // 四维消耗 + 天气修正（性状：抗旱减半耗水、脆弱放大天气损耗）
      const waterDecayMul = (tset.has('droughthardy') ? 0.5 : 1) * traitMul('weak', (TRAITS.weak.mods.weatherMul))
      const weatherMul = traitMul('weak', TRAITS.weak.mods.weatherMul)
      let water = pl.water - (12 + Math.round(Math.random() * 12)) * waterDecayMul
        + (mods.waterAdd || 0) * weatherMul
      let fert = pl.fert - (8 + Math.round(Math.random() * 8)) + (mods.fertAdd || 0) * weatherMul
      let light = pl.light - (6 + Math.round(Math.random() * 8)) + (mods.lightAdd || 0) * weatherMul + mods.lightRecover
      // 季节光照影响
      if (season === 3) light -= 10
      // 降雨/暴雨直接灌满
      if (mods.setWater != null) water = mods.setWater
      water = clamp100(water); fert = clamp100(fert); light = clamp100(light)
      // 虫害：抗虫品种自然生虫率大减
      const pestChance = 0.25 * (tset.has('pestresist') ? (TRAITS.pestresist.mods.pestChanceMul) : 1)
      let pest = Math.max(0, pl.pest + (Math.random() < pestChance ? 1 : 0) + (mods.pestAdd || 0) * weatherMul)
      // 虫害过高会降低属性；恶劣天气可能阻止生长（抗寒/抗旱品种可抵抗对应停长）
      let blocked = !!mods.growthBlock
      if (blocked) {
        if (tset.has('frosthardy') && ['frost', 'freeze', 'blizzard'].includes(wType)) blocked = false
        if (tset.has('droughthardy') && wType === 'drought') blocked = false
      }
      const flux = water >= 30 && fert >= 30 && light >= 30 && pest <= 0.6 && !blocked
      const full = pl.stage >= (crop.days - 1)
      let stage = pl.stage
      if (!full && flux) {
        stage += 1
        // 速生：条件良好时一天长两阶
        if (tset.has('fastgrow') && Math.random() < TRAITS.fastgrow.mods.bonusGrowChance) {
          stage = Math.min(crop.days - 1, stage + 1)
        }
      }
      // 恶劣天气可能打坏作物（倒退一阶段）
      if (stage > 0 && mods.stageRegressChance > 0 && Math.random() < mods.stageRegressChance) stage -= 1
      run(`UPDATE plots SET water=?,fert=?,light=?,pest=?,stage=? WHERE id=?`, water, fert, light, pest, stage, pl.id)
    }
    // 动物喂食衰减 + 天气伤害/恢复 + 产物就绪
    const animals = q('SELECT * FROM animals WHERE farm_id=?', farmId)
    for (const a of animals) {
      const feed = Math.max(0, a.feed - 25)
      let health = a.health - (feed === 0 ? 20 : 6) + mods.animalHpAdd
      if (feed > 0) health += mods.animalRecover
      health = Math.max(0, Math.min(100, health))
      run(`UPDATE animals SET feed=?,health=?,ready=1 WHERE id=?`, feed, health, a.id)
    }
    // —— 灌溉：降雨补水/干旱耗水，连通网络内多池统一分水（结合天气与品种耗水调度）——
    logs.push(...settleIrrigation({ type: wType, severity: wSev, mods }, p.abs_day, farmId))
    // —— 育种：试验随天推进，受养护与天气影响，成熟产出新品种种子 ——
    logs.push(...settleBreeding({ type: wType, severity: wSev, mods }, p.abs_day + 1, farmId))
    // 天数推进与季节轮转
    if (day > 28) {
      day = 1
      season = (season + 1) % 4
    }
    run('UPDATE player SET day=?, season=?, abs_day=abs_day+1 WHERE farm_id=?', day, season, farmId)
    // —— 加工队列：按游戏天推进，完工批次落库（与天气/作物同一事务，失败整体回滚）——
    logs.push(...settleProduction(p.abs_day + 1, farmId))
    // 生成次日天气（持续中的事件会自然延续）
    ensureWeather(season, day, p.abs_day + 1, farmId)
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
  return logs
}

const PORT = 4110
app.listen(PORT, () => console.log(`[FARM] API running at http://localhost:${PORT}`))
