import { db } from './db.js'
import {
  replay, finishedBatchesAt, startedBatchesAt, splitIntoBatches,
  waitingInputsOf, reservedItems, planReorder
} from './production-core.js'

// ===== 配方表（以服务端为准，前端仅做展示）=====
// days：每批耗时（游戏天）；needLv：加工坊等级要求
// baseCrop：本源基础作物 id；设置后该配方可消耗任意同本源的杂交品种作物（贯通新品种加工）
export const RECIPES = [
  {
    id: 'flour', name: '面粉', icon: '🍞',
    from: 'crop-5', fromName: '小麦', fromIcon: '🌾', fromCat: 'crop',
    baseCrop: 5,
    consume: 2, result: 'flour', resultName: '面粉', resultCat: 'material',
    gain: 1, days: 1, needLv: 1
  },
  {
    id: 'juice', name: '番茄汁', icon: '🧃',
    from: 'crop-2', fromName: '番茄', fromIcon: '🍅', fromCat: 'crop',
    baseCrop: 2,
    consume: 2, result: 'juice', resultName: '番茄汁', resultCat: 'product',
    gain: 1, days: 1, needLv: 1
  },
  {
    id: 'cheese', name: '奶酪', icon: '🧀',
    from: 'p-cow', fromName: '牛奶', fromIcon: '🥛', fromCat: 'product',
    consume: 2, result: 'cheese', resultName: '奶酪', resultCat: 'product',
    gain: 1, days: 2, needLv: 1
  },
  {
    id: 'bread', name: '面包', icon: '🥖',
    from: 'flour', fromName: '面粉', fromIcon: '🍞', fromCat: 'material',
    consume: 2, result: 'bread', resultName: '面包', resultCat: 'product',
    gain: 1, days: 2, needLv: 2
  },
  {
    id: 'wool', name: '毛线', icon: '🧵',
    from: 'p-sheep', fromName: '羊毛', fromIcon: '🧶', fromCat: 'product',
    consume: 1, result: 'wool', resultName: '毛线', resultCat: 'product',
    gain: 1, days: 1, needLv: 3
  },
  {
    id: 'popcorn', name: '烤玉米', icon: '🍿',
    from: 'crop-3', fromName: '玉米', fromIcon: '🌽', fromCat: 'crop',
    baseCrop: 3,
    consume: 2, result: 'popcorn', resultName: '烤玉米', resultCat: 'product',
    gain: 1, days: 1, needLv: 4
  },
  {
    id: 'pickle', name: '泡菜', icon: '🥬',
    from: 'crop-6', fromName: '白菜', fromIcon: '🥬', fromCat: 'crop',
    baseCrop: 6,
    consume: 3, result: 'pickle', resultName: '泡菜', resultCat: 'product',
    gain: 2, days: 2, needLv: 5
  }
]

export function getRecipe(id) {
  return RECIPES.find((r) => r.id === id) || null
}

// 队列容量：加工坊等级越高，同时排队的批次越多
export function capacity(millLevel = 1) {
  return 2 + millLevel * 2
}

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// 农场内库存与工单操作
function stockOf(farmId, itemId) {
  return q1('SELECT qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)?.qty || 0
}
// 配方原料可用量：设置了 baseCrop 的配方，本源基础作物与同本源杂交品种作物合并计算
function recipeStock(farmId, r) {
  if (!r.baseCrop) return stockOf(farmId, r.from)
  let total = stockOf(farmId, 'crop-' + r.baseCrop)
  for (const v of q('SELECT id FROM crop_varieties WHERE farm_id=? AND base_id=?', farmId, r.baseCrop)) {
    total += stockOf(farmId, 'crop-v' + v.id)
  }
  return total
}
// 按本源扣减原料：先消耗基础作物，再按品种代数从低到高（优先普通品种）
// 返回实际扣减明细 [{itemId,name,cat,qty}]（杂交品种可能是基础作物也可能是杂交作物，取消退料必须原样退回）
function consumeCropByBase(farmId, baseId, need) {
  let remain = need
  const taken = []
  // 从指定库存行扣 n 个并登记实际来源
  const take = (invId, itemId, name, cat, qty) => {
    const n = Math.min(remain, qty)
    if (n <= 0) return
    run('UPDATE inventory SET qty=qty-? WHERE id=?', n, invId)
    taken.push({ itemId, name, cat, qty: n })
    remain -= n
  }
  const base = q1('SELECT * FROM inventory WHERE farm_id=? AND item_id=?', farmId, 'crop-' + baseId)
  if (base) take(base.id, 'crop-' + baseId, base.name, base.cat, base.qty)
  if (remain > 0) {
    const vars = q(`SELECT i.id AS inv_id, i.item_id, i.name, i.cat, i.qty
                    FROM inventory i
                    JOIN crop_varieties v ON i.item_id = 'crop-v' || v.id
                    WHERE v.farm_id=? AND v.base_id=? AND i.qty>0 ORDER BY v.gen ASC, v.id ASC`, farmId, baseId)
    for (const s of vars) {
      if (remain <= 0) break
      take(s.inv_id, s.item_id, s.name, s.cat, s.qty)
    }
  }
  cleanEmpty(farmId)
  return { taken, got: need - remain }
}
// 扣减单一原料（非杂交贯通配方），返回实际扣减明细
function consumeItem(farmId, itemId, need) {
  const row = q1('SELECT * FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)
  const n = Math.min(need, row?.qty || 0)
  if (n <= 0) return { taken: [], got: 0 }
  run('UPDATE inventory SET qty=qty-? WHERE id=?', n, row.id)
  cleanEmpty(farmId)
  return { taken: [{ itemId, name: row.name, cat: row.cat, qty: n }], got: n }
}
// 纯逻辑（队列重放/批次判定/投料拆分/占用汇总/重排计划）见 server/production-core.js
// 重放与逐批判定在本模块内继续使用；取消/重排逻辑与跨天结算共用同一套计算
export {
  replay, finishedBatchesAt, startedBatchesAt,
  splitIntoBatches, waitingInputsOf, reservedItems, planReorder
}

// 该农场全部工单重放（含已取消/已入库——它们历史上占用过机器时间，影响后续工单排期）
// 多人协作：按计划顺序 seq 串行（创建时同序；成员重排只交换 seq），id 仅作并列兜底
function allJobs(farmId) {
  return replay(q('SELECT * FROM production_jobs WHERE farm_id=? ORDER BY seq, id', farmId))
}
function addInv(farmId, itemId, name, cat, n) {
  const row = q1('SELECT qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)
  if (row) run('UPDATE inventory SET qty=qty+? WHERE id=?', n, row.id)
  else run('INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (?,?,?,?,?)', farmId, itemId, name, cat, n)
}
function cleanEmpty(farmId) {
  run('DELETE FROM inventory WHERE farm_id=? AND qty<=0', farmId)
}

// 农场内全部成员名（工单创建者展示用）
function usersOf(farmId) {
  return new Map(q(
    `SELECT u.id, u.name FROM users u
     JOIN farm_members m ON m.user_id=u.id WHERE m.farm_id=?`, farmId
  ).map((u) => [u.id, u.name]))
}

// 当前在队（未领走）的工单 + 动态状态。
// viewer = { userId, role } 时附带协作权限（自己创建 / 管理员）与排队顺位、未开工投料。
export function listJobs(currentAbs, farmId, viewer = null) {
  const all = allJobs(farmId)
  const userNames = usersOf(farmId)
  const isManager = viewer && (viewer.role === 'admin' || viewer.role === 'owner')
  // 可移动（尚未开工）的在制工单构成重排窗口，按计划顺序给出队首起的排队顺位
  const movableIds = new Set(all
    .filter((j) => j.status === 'running' && j.start > currentAbs)
    .map((j) => j.id))
  const movableList = all.filter((j) => movableIds.has(j.id))
  const jobs = []
  for (const j of all) {
    if (j.status === 'collected') continue
    j.doneBatches = finishedBatchesAt(j, currentAbs)
    // 已全部退料的取消工单没有可领成品，直接出队
    if (j.status === 'canceled' && j.doneBatches === 0) continue
    j.startedBatches = j.status === 'canceled'
      ? startedBatchesAt(j, j.cancel_abs)
      : startedBatchesAt(j, currentAbs)
    // 取消时实际退料的批次数 = 取消时点尚未开工的批次
    j.refundedBatches = j.status === 'canceled' ? Math.max(0, j.qty - j.startedBatches) : 0
    j.waitingBatches = j.status === 'running' ? j.qty - j.doneBatches : 0
    j.computedStatus = j.status === 'running'
      ? (j.doneBatches >= j.qty ? 'done' : 'running')
      : j.status
    j.remainDays = j.computedStatus === 'running'
      ? Math.max(0, j.finish - currentAbs)
      : 0
    // 协作归属：谁排产的谁展示头像；旧工单 created_by 为空视为全场共有
    j.createdByName = j.created_by != null ? (userNames.get(j.created_by) || `成员#${j.created_by}`) : null
    if (viewer) {
      j.owned = j.created_by == null || j.created_by === viewer.userId || isManager
      j.canCancel = j.status === 'running' && j.owned
      j.movable = movableIds.has(j.id) && j.owned
      j.waitOrder = j.movable ? movableList.findIndex((x) => x.id === j.id) + 1 : 0
      // 未开工批次锁定的原料（取消可退；品种明细原样追踪）
      j.waitingInputs = j.status === 'running' ? waitingInputsOf(j, j.startedBatches) : []
    }
    jobs.push(j)
  }
  return jobs
}

// 全农场原料占用汇总：所有在制工单未开工批次已出库、可退的原料（多人协作排产展示用）
export function productionReserved(currentAbs, farmId) {
  return reservedItems(allJobs(farmId), currentAbs)
}

// 在队批次占用（用于容量限制，已取消/已全部完工的工单不再占坑）
export function queuedBatches(currentAbs, farmId) {
  return listJobs(currentAbs, farmId)
    .filter((j) => j.computedStatus === 'running')
    .reduce((s, j) => s + j.waitingBatches, 0)
}

// 推进游戏天时结算：把跨天完工的批次落库（幂等：finished 只增不减），
// 返回完工日志。toAbs 为结算后的绝对日。
// 注意：本函数在 advanceDay 的事务内调用，不再另开事务。
export function settleProduction(toAbs, farmId) {
  const logs = []
  for (const j of allJobs(farmId)) {
    if (j.status !== 'running') continue
    const done = finishedBatchesAt(j, toAbs)
    if (done > j.finished) {
      const add = done - j.finished
      const status = done >= j.qty ? 'done' : 'running'
      run('UPDATE production_jobs SET finished=?, status=? WHERE id=?', done, status, j.id)
      logs.push(`✅ ${j.recipe_name} 新完工 ${add} 批（共 ${done}/${j.qty}），可去加工坊入库`)
    }
  }
  return logs
}

// 批量排产：一个配方一次下 n 批；原料当场全部扣走（含品种逐项登记）。
// userId 为排产成员：多人协作中工单按创建者归属，取消/重排权限据此判定；
// seq 为队内计划顺序，新工单追加到队尾（在全部历史工单之后）。
export function enqueueJob({ recipeId, qty, millLevel, currentAbs, farmId, userId }) {
  const r = getRecipe(recipeId)
  if (!r) throw Object.assign(new Error('配方不存在'), { status: 404 })
  const n = Math.max(1, Math.min(Math.floor(Number(qty) || 1), 99))
  if (millLevel < r.needLv) throw Object.assign(new Error('加工坊等级不足'), { status: 400 })
  const used = queuedBatches(currentAbs, farmId)
  if (used + n > capacity(millLevel)) {
    throw Object.assign(new Error(`队列已满（${used}/${capacity(millLevel)} 批），等工单完工或取消一些再排产`), { status: 400 })
  }
  const need = r.consume * n
  if (recipeStock(farmId, r) < need) throw Object.assign(new Error(`原料不足：需要 ${r.fromName} ×${need}`), { status: 400 })
  db.exec('BEGIN IMMEDIATE')
  try {
    const { taken, got } = r.baseCrop
      ? consumeCropByBase(farmId, r.baseCrop, need)
      : consumeItem(farmId, r.from, need)
    if (got < need) throw Object.assign(new Error(`原料不足：需要 ${r.fromName} ×${need}`), { status: 400 })
    // 按批次登记实际投料来源（基础作物/杂交品种逐项记录），取消未开工批次时原样退回
    const inputs = JSON.stringify(splitIntoBatches(taken, r.consume, n))
    // 队尾计划顺序：取全农场最大 seq +1（历史工单也参与，保证新单排到最后）
    const seq = (q1('SELECT COALESCE(MAX(seq),0) s FROM production_jobs WHERE farm_id=?', farmId)?.s || 0) + 1
    const res = run(
      `INSERT INTO production_jobs
       (farm_id,recipe_id,recipe_name,result_id,result_name,result_cat,from_id,from_name,from_cat,
        consume,gain,days,qty,finished,enqueue_abs,inputs,status,seq,created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,'running',?,?)`,
      farmId, r.id, r.name, r.result, r.resultName, r.resultCat,
      r.from, r.fromName, r.fromCat, r.consume, r.gain, r.days, n, currentAbs, inputs,
      seq, userId ?? null
    )
    db.exec('COMMIT')
    return { ok: true, id: res.lastInsertRowid }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 取消工单：退还尚未开工批次的原料；已开工（含加工中）批次不退料，
// 已完工批次保留成品待入库，加工中批次随取消作废。
// 退料按排产时逐批登记的实际投料（可能含杂交品种作物）原样退回，
// 而不是统一退成配方本源基础作物；旧工单无登记时回退按配方原料退。
// 多人协作：仅创建者本人或管理员/场主可取消（旧工单无创建者视为全场共有）。
export function cancelJob({ id, currentAbs, farmId, viewer }) {
  const j = q1('SELECT * FROM production_jobs WHERE farm_id=? AND id=?', farmId, id)
  if (!j) throw Object.assign(new Error('工单不存在'), { status: 404 })
  if (j.status !== 'running') throw Object.assign(new Error('该工单已结束，无法取消'), { status: 400 })
  if (viewer) {
    const isManager = viewer.role === 'admin' || viewer.role === 'owner'
    if (j.created_by != null && j.created_by !== viewer.userId && !isManager) {
      throw Object.assign(new Error('只能取消自己排产的工单（管理员可代操作）'), { status: 403 })
    }
  }

  const cur = allJobs(farmId).find((x) => x.id === id)
  const finishedBatches = finishedBatchesAt(cur, currentAbs)
  // 正在加工的批次已投入原料、尚未产出，取消即作废；只退还没开工的批次
  const startedBatches = startedBatchesAt(cur, currentAbs)
  const refundBatches = Math.max(0, j.qty - startedBatches)
  // 未开工的是尾部 refundBatches 批（下标 startedBatches..qty-1），按实际投料原样退回
  const refunds = refundBatches > 0 ? waitingInputsOf(j, startedBatches) : []

  db.exec('BEGIN IMMEDIATE')
  try {
    run('UPDATE production_jobs SET status=\'canceled\', cancel_abs=?, finished=? WHERE id=?',
      currentAbs, finishedBatches, id)
    for (const it of refunds) addInv(farmId, it.itemId, it.name, it.cat, it.qty)
    db.exec('COMMIT')
    return { ok: true, refundBatches, finishedBatches, refunds }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 队列重排（多人协作）：把自己尚未开工的工单在排队窗口内上移/下移一位，
// 与相邻排队工单交换计划顺序 seq；正在加工的工单是锚点，不能越过。
// 只交换 seq：各工单逐批登记的投料不变，机器从下次空闲起按新顺序加工。
export function reorderJob({ id, dir, currentAbs, farmId, viewer }) {
  const j = q1('SELECT * FROM production_jobs WHERE farm_id=? AND id=?', farmId, id)
  if (!j) throw Object.assign(new Error('工单不存在'), { status: 404 })
  if (viewer) {
    const isManager = viewer.role === 'admin' || viewer.role === 'owner'
    if (j.created_by != null && j.created_by !== viewer.userId && !isManager) {
      throw Object.assign(new Error('只能调整自己排产的工单顺序（管理员可代操作）'), { status: 403 })
    }
  }
  // 重放后由纯逻辑给出交换计划（并校验可移动性/边缘）
  const { assign, swappedId } = planReorder(allJobs(farmId), currentAbs, id, String(dir || ''))
  if (!assign.length) return { ok: true, moved: false }
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [jobId, newSeq] of assign) {
      run('UPDATE production_jobs SET seq=? WHERE farm_id=? AND id=?', newSeq, farmId, jobId)
    }
    db.exec('COMMIT')
    return { ok: true, moved: true, swappedId }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// 完工入库：领取指定工单成品；不传 id 则一键领取全部待入库工单
export function collectJobs(currentAbs, farmId, id = null) {
  const rows = id
    ? q("SELECT * FROM production_jobs WHERE farm_id=? AND id=? AND status!='collected'", farmId, id)
    : q("SELECT * FROM production_jobs WHERE farm_id=? AND status!='collected' ORDER BY id", farmId)
  if (!rows.length) throw Object.assign(new Error('没有可入库的工单'), { status: 400 })

  const byId = new Map(allJobs(farmId).map((j) => [j.id, j]))

  const picked = []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const j of rows) {
      const batches = finishedBatchesAt(byId.get(j.id), currentAbs)
      // 只有全部完工或已取消的工单才能入库（在制工单按整单领取，避免丢批次）
      const settled = j.status === 'canceled' || batches >= j.qty
      if (!settled || batches <= 0) {
        if (id) {
          throw Object.assign(
            new Error(batches <= 0 ? '该工单尚无完工批次' : '工单尚未全部完工，完工后才能入库'),
            { status: 400 }
          )
        }
        continue
      }
      addInv(farmId, j.result_id, j.result_name, j.result_cat, j.gain * batches)
      run("UPDATE production_jobs SET status='collected' WHERE id=?", j.id)
      picked.push({ name: j.result_name, qty: j.gain * batches })
    }
    if (!picked.length) throw Object.assign(new Error('没有可入库的成品'), { status: 400 })
    db.exec('COMMIT')
    return { ok: true, picked }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}
