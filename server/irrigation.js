import { db } from './db.js'
import { TRAITS, cropLike } from './breeding.js'
import { buildNetworks, planAllocation } from './irrigation-core.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 灌溉参数 =====
export const COSTS = { reservoir: 60, canal: 8 }   // 建造花费（金币）
export const RESERVOIR_CAP = 150                   // 蓄水池容量
export const RESERVOIR_INIT = 50                   // 建成时自带水量
export const DEMOLISH_REFUND = 0.5                 // 拆除返还比例
export const MAP_W = 15                            // 地图格数（900/60）
export const MAP_H = 10                            // 地图格数（620/60 取整）

// 天气对蓄水池的每日影响：正=降雨补水，负=蒸发耗水（负值乘灾害等级）
const WEATHER_WATER = { rain: 35, storm: 50, drought: -15, heatwave: -8 }

// 农场内建筑占地（2x2）不可建灌溉设施
function blockedCells(farmId) {
  const blocked = new Set()
  for (const b of q('SELECT x,y FROM buildings WHERE farm_id=?', farmId)) {
    for (let dx = 0; dx < 2; dx++) {
      for (let dy = 0; dy < 2; dy++) blocked.add(`${b.x + dx},${b.y + dy}`)
    }
  }
  return blocked
}

// 当前农场供水网络列表：启用中的蓄水池+水渠按 4 连通分组（含水量/容量汇总）。
// 停用/拆除的设施不参与，因此断流与恢复都由每日实时重算自然生效。
export function computeNetworks(farmId) {
  const plots = q('SELECT * FROM plots WHERE farm_id=?', farmId)
  const facilities = q('SELECT * FROM irrigation WHERE farm_id=?', farmId)
  return buildNetworks(facilities, plots).map((n) => ({
    ...n,
    water: n.reservoirs.reduce((s, r) => s + r.water, 0),
    cap: n.reservoirs.length * RESERVOIR_CAP
  }))
}

// 供水网络汇总视图：连通且启用中的地块/水渠 id 集合（前端绘制供水状态用）
export function networkInfo(networks) {
  const plotIds = new Set()
  const canalIds = new Set()
  for (const n of networks) {
    if (!n.reservoirs.length) continue // 没有蓄水池的网络不供水
    n.plotIds.forEach((id) => plotIds.add(id))
    n.canalIds.forEach((id) => canalIds.add(id))
  }
  return { plotIds, canalIds }
}

// 最近一次每日供水的分配结果（缺水时前端展示明细）
export function lastReport(farmId) {
  const row = q1('SELECT detail FROM irrigation_report WHERE farm_id=? ORDER BY abs_day DESC LIMIT 1', farmId)
  if (!row) return null
  try { return JSON.parse(row.detail) } catch { return null }
}

// 建造蓄水池/水渠：校验地块、占用与金币，事务落库
export function buildFacility(farmId, kind, x, y) {
  if (!COSTS[kind]) throw Object.assign(new Error('未知的设施类型'), { status: 400 })
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) {
    throw Object.assign(new Error('超出可建造范围'), { status: 400 })
  }
  if (q1('SELECT id FROM plots WHERE farm_id=? AND x=? AND y=?', farmId, x, y)) {
    throw Object.assign(new Error('不能建在耕地上，请铺到耕地旁'), { status: 400 })
  }
  if (blockedCells(farmId).has(`${x},${y}`)) {
    throw Object.assign(new Error('此处已被建筑占用'), { status: 400 })
  }
  if (q1('SELECT id FROM irrigation WHERE farm_id=? AND x=? AND y=?', farmId, x, y)) {
    throw Object.assign(new Error('此处已有灌溉设施'), { status: 400 })
  }
  const cost = COSTS[kind]
  const p = q1('SELECT gold FROM player WHERE farm_id=?', farmId)
  if (p.gold < cost) throw Object.assign(new Error('金币不足'), { status: 400 })
  db.exec('BEGIN IMMEDIATE')
  try {
    run('UPDATE player SET gold=gold-? WHERE farm_id=?', cost, farmId)
    const r = run(
      'INSERT INTO irrigation (farm_id,kind,x,y,active,water) VALUES (?,?,?,?,1,?)',
      farmId, kind, x, y, kind === 'reservoir' ? RESERVOIR_INIT : 0
    )
    db.exec('COMMIT')
    return { ok: true, id: r.lastInsertRowid, cost }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 停用/启用：停用即断流（不再参与供水网络），启用后次日结算自动恢复
export function toggleFacility(farmId, id) {
  const f = q1('SELECT * FROM irrigation WHERE farm_id=? AND id=?', farmId, id)
  if (!f) throw Object.assign(new Error('设施不存在'), { status: 404 })
  const active = f.active ? 0 : 1
  run('UPDATE irrigation SET active=? WHERE id=?', active, id)
  return { ok: true, active }
}

// 拆除：返还部分造价，蓄水池余水作废；断流的地块由网络重算自动体现
export function demolishFacility(farmId, id) {
  const f = q1('SELECT * FROM irrigation WHERE farm_id=? AND id=?', farmId, id)
  if (!f) throw Object.assign(new Error('设施不存在'), { status: 404 })
  const refund = Math.floor(COSTS[f.kind] * DEMOLISH_REFUND)
  db.exec('BEGIN IMMEDIATE')
  try {
    run('DELETE FROM irrigation WHERE id=?', id)
    if (refund > 0) run('UPDATE player SET gold=gold+? WHERE farm_id=?', refund, farmId)
    db.exec('COMMIT')
    return { ok: true, refund }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 逐日结算（在 advanceDay 事务内调用，不另开事务）：
// 1) 天气影响：降雨/暴雨为蓄水池补水，干旱/酷暑加速蒸发
// 2) 统一分水：同一连通网络内的多座蓄水池汇成统一水池，结合天气与品种耗水估算，
//    按 保水优先级高→低、预计最快缺水者优先 的顺序，把有限水量浇到各地块目标水分
// 3) 分配结果落库（缺水时前端展示明细）+ 干涸断流预警
export function settleIrrigation(weather, absDay, farmId) {
  const { type: weatherType, severity = 0, mods = null } = weather || {}
  const logs = []
  const allReservoirs = q("SELECT * FROM irrigation WHERE farm_id=? AND kind='reservoir'", farmId)

  // —— 天气补水/耗水（含停用中的池子：停用只是断流，池水仍受天气影响）——
  const delta = WEATHER_WATER[weatherType] || 0
  if (allReservoirs.length && delta !== 0) {
    const d = delta < 0 ? delta * Math.max(1, severity) : delta
    for (const r of allReservoirs) {
      const w = Math.max(0, Math.min(RESERVOIR_CAP, r.water + d))
      if (w !== r.water) run('UPDATE irrigation SET water=? WHERE id=?', w, r.id)
    }
    logs.push(delta > 0
      ? `🌧️ 降水为所有蓄水池补水 +${d}`
      : `🏜️ 干热蒸发，所有蓄水池水量 ${d}`)
  }

  // —— 按连通网络统一分水（网络每日实时重算，停用/拆除后自动生效）——
  const plots = q('SELECT * FROM plots WHERE farm_id=?', farmId)
  const facilities = q('SELECT * FROM irrigation WHERE farm_id=?', farmId)
  const networks = buildNetworks(facilities, plots).filter((n) => n.reservoirs.length)
  const { give, reservoirWater, report, totals, waterNow } = planAllocation({
    networks,
    plots,
    cropOf: (cid) => cropLike(farmId, cid),
    mods,
    traitsDef: TRAITS,
    cap: RESERVOIR_CAP
  })
  for (const [pid, g] of give) run('UPDATE plots SET water=MIN(100, water+?) WHERE id=?', g, pid)
  for (const [rid, w] of reservoirWater) run('UPDATE irrigation SET water=? WHERE id=?', w, rid)

  // —— 分配结果落库：同日覆盖（幂等），仅保留最近 10 天；无设施时也写空报告避免展示过期数据 ——
  report.absDay = absDay
  report.weather = weatherType
  run('INSERT OR REPLACE INTO irrigation_report (farm_id,abs_day,detail) VALUES (?,?,?)', farmId, absDay, JSON.stringify(report))
  run('DELETE FROM irrigation_report WHERE farm_id=? AND abs_day < ?', farmId, absDay - 9)

  if (totals.fed) {
    logs.push(`💧 灌溉完成：${totals.fed} 块地共供水 ${totals.used}${totals.shortCount ? `；水量不足，${totals.shortCount} 块地未浇足（缺 ${totals.shortAmount}）` : ''}`)
  } else if (totals.shortCount) {
    logs.push(`🚱 蓄水池水量不足：${totals.shortCount} 块地未浇到水（缺 ${totals.shortAmount}）`)
  }

  // —— 干涸断流预警：网络水池见底，且连通地块仍有作物缺水 ——
  for (const net of networks) {
    const netReport = report.networks.find((n) => n.id === net.id)
    if ((netReport?.poolAfter ?? 0) > 0) continue
    const needy = plots.filter((p) =>
      net.plotIds.has(p.id) && p.crop_id &&
      waterNow.get(p.id) < 60 && waterNow.get(p.id) < (p.irr_target ?? 100)
    ).length
    if (needy) logs.push(`⚠️ 供水网络#${net.id} 蓄水池干涸断流，${needy} 块地缺水，等待降雨补水`)
  }
  return logs
}
