// ===== 加工排产纯逻辑：队列重放 / 投料拆分 / 原料占用 / 队列重排 =====
// 不依赖数据库（便于单测）；DB 读写见 server/production.js

// 截至 atAbs 时，某工单已完工的批次数（取消后不再增加）
export function finishedBatchesAt(j, atAbs) {
  const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
  const eff = Math.min(atAbs, stop)
  return Math.min(j.qty, Math.max(0, Math.floor((eff - j.start) / j.days)))
}

// 截至 atAbs 时，某工单已开工的批次数（正在加工中的批次也算开工，原料不可退）
export function startedBatchesAt(j, atAbs) {
  const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
  const eff = Math.min(atAbs, stop)
  return Math.min(j.qty, Math.max(0, Math.floor((eff - j.start) / j.days) + 1))
}

// 队列重放：加工坊只有一台机器，按计划顺序（seq 升序）串行加工，算出每个工单
//   start  —— 首批开工绝对日（当天 00:00 即可开工）
//   finish —— 全部批次完工的绝对日（用于预估还剩几天）
// 取消的工单在 cancel_abs 立刻让出机器，后续工单自动提前；
// 尚未开工就被取消的工单从未占用机器，游标不得回退（否则后续工单会排到过去、提前产出）。
// 多人协作中成员可重排「尚未开工」的工单：只交换 seq，重放结果自然随之改变。
export function replay(jobs) {
  let cursor = 0
  for (const j of jobs) {
    const start = Math.max(cursor, j.enqueue_abs)
    j.start = start
    const stop = j.cancel_abs == null ? Infinity : j.cancel_abs
    let finish = start
    for (let b = 0; b < j.qty; b++) {
      const bEnd = start + (b + 1) * j.days
      if (bEnd > stop) break
      finish = bEnd
    }
    if (j.cancel_abs == null) {
      j.finish = finish
      cursor = finish
    } else if (start < stop) {
      // 取消时已有批次开工（可能正加工到一半）：机器一直占用到取消时刻才让出
      j.finish = stop
      cursor = stop
    } else {
      // 取消时还没轮到开工：这张工单没碰过机器，游标保持不动
      j.finish = start
    }
  }
  return jobs
}

// 解析排产时逐批登记的投料明细（损坏/缺失时返回 null，由调用方回退旧逻辑）
export function parseInputs(raw) {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : null
  } catch { return null }
}

// 把按消耗顺序排列的扣减明细按每批 consume 个切分，登记到每一批
// （机器先开的批次先投料，故未开工的尾部批次取消时要原样拿回自己的投料）
export function splitIntoBatches(taken, perBatch, batches) {
  const flat = []
  for (const t of taken) for (let i = 0; i < t.qty; i++) flat.push(t)
  const result = []
  for (let b = 0; b < batches; b++) {
    const map = new Map()
    for (const t of flat.slice(b * perBatch, (b + 1) * perBatch)) {
      const cur = map.get(t.itemId)
      if (cur) cur.qty += 1
      else map.set(t.itemId, { itemId: t.itemId, name: t.name, cat: t.cat, qty: 1 })
    }
    result.push([...map.values()])
  }
  return result
}

// 合并多组投料明细为按物品聚合的数组（输出顺序稳定，便于展示与测试）
export function mergeInputs(groups) {
  const map = new Map()
  for (const items of groups) {
    for (const it of items || []) {
      const cur = map.get(it.itemId)
      if (cur) cur.qty += it.qty
      else map.set(it.itemId, { itemId: it.itemId, name: it.name, cat: it.cat, qty: it.qty })
    }
  }
  return [...map.values()].filter((it) => it.qty > 0).sort((a, b) => a.itemId.localeCompare(b.itemId))
}

// 某工单尚未开工批次（下标 started..qty-1）锁定的原料明细，按物品聚合。
// 这些原料在排产时已出库，但取消未开工批次时会原样退回，因此在协作排产中
// 仍按「占用中（可退）」追踪；正在加工的批次原料不可退，不计入占用。
// 旧工单无逐批登记时回退为按配方原料统一折算。
export function waitingInputsOf(job, startedBatches) {
  const perBatch = parseInputs(job.inputs)
  if (perBatch) {
    const items = mergeInputs(perBatch.slice(startedBatches, job.qty))
    if (items.length) return items
  }
  const waiting = Math.max(0, job.qty - startedBatches)
  if (waiting <= 0 || !job.from_id) return []
  return [{ itemId: job.from_id, name: job.from_name, cat: job.from_cat, qty: job.consume * waiting }]
}

// 全农场在制工单的未开工批次原料占用汇总（多人协作：他人工单锁定的原料自己不能再用）
// jobs 需为重放后的工单（含 start/status）；返回 [{itemId,name,cat,qty}]
export function reservedItems(jobs, currentAbs) {
  const groups = []
  for (const j of jobs) {
    if (j.status !== 'running') continue
    const started = startedBatchesAt(j, currentAbs)
    if (started >= j.qty) continue
    groups.push(waitingInputsOf(j, started))
  }
  return mergeInputs(groups)
}

// 尚未开工、仍可调整顺序的工单（机器串行：正在加工的批次不可挪，已完工/取消的不可挪）
export function movableJobs(jobs, currentAbs) {
  return jobs.filter((j) => j.status === 'running' && j.start > currentAbs)
}

// 队列重排计划：把目标工单在「可移动窗口」内上移/下移一位，与相邻工单交换 seq。
// 可移动窗口只含尚未开工的在制工单——正在加工的工单是锚点，排队工单不能越过它。
// 返回 { assign: [[jobId,newSeq],...], swappedId }；已在边缘时为空操作。
export function planReorder(jobs, currentAbs, targetId, dir) {
  if (dir !== 'up' && dir !== 'down') {
    throw Object.assign(new Error('重排方向只能是 up/down'), { status: 400 })
  }
  const movable = movableJobs(jobs, currentAbs)
  const idx = movable.findIndex((j) => j.id === targetId)
  if (idx < 0) {
    throw Object.assign(new Error('该工单已开工或已结束，不能调整顺序'), { status: 400 })
  }
  const target = movable[idx]
  const other = dir === 'up' ? movable[idx - 1] : movable[idx + 1]
  if (!other) return { assign: [], swappedId: null }
  return { assign: [[target.id, other.seq], [other.id, target.seq]], swappedId: other.id }
}
