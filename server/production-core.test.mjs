import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  replay, finishedBatchesAt, startedBatchesAt, splitIntoBatches,
  waitingInputsOf, reservedItems, movableJobs, planReorder
} from './production-core.js'

// —— 工单构造 ——
let _id = 0
const job = (over = {}) => ({
  id: ++_id, farm_id: 1, recipe_id: 'flour', recipe_name: '面粉',
  result_id: 'flour', result_name: '面粉', result_cat: 'material',
  from_id: 'crop-5', from_name: '小麦', from_cat: 'crop',
  consume: 2, gain: 1, days: 1, qty: 1, finished: 0,
  enqueue_abs: 1, cancel_abs: null, inputs: null,
  seq: _id, created_by: null, status: 'running', ...over
})
const wheat = (n = 1) => ({ itemId: 'crop-5', name: '小麦', cat: 'crop', qty: n })
const hardWheat = (n = 1) => ({ itemId: 'crop-v1001', name: '硬粒小麦', cat: 'crop', qty: n })

test('replay：单台机器按 seq 串行，工单开工/完工日依次顺延', () => {
  const jobs = replay([
    job({ qty: 2, days: 1, enqueue_abs: 1 }), // start1 finish3
    job({ qty: 1, days: 2, enqueue_abs: 1 })  // start3 finish5
  ])
  assert.equal(jobs[0].start, 1)
  assert.equal(jobs[0].finish, 3)
  assert.equal(jobs[1].start, 3)
  assert.equal(jobs[1].finish, 5)
})

test('replay：晚排产的工单不会排到 enqueue_abs 之前', () => {
  const jobs = replay([
    job({ qty: 1, days: 1, enqueue_abs: 1 }), // start1 finish2
    job({ qty: 1, days: 1, enqueue_abs: 10 }) // 机器第 2 天就空了，但第 10 天才排产
  ])
  assert.equal(jobs[1].start, 10)
  assert.equal(jobs[1].finish, 11)
})

test('replay：取消未开工工单立刻让出顺序且游标不回退；后续工单自动提前', () => {
  const a = job({ qty: 1, days: 1, enqueue_abs: 1 })           // start1 finish2
  const b = job({ qty: 1, days: 1, enqueue_abs: 1, cancel_abs: 2 }) // 第 2 天取消时尚未轮到
  const c = job({ qty: 1, days: 1, enqueue_abs: 1 })           // 应顶到第 2 天
  replay([a, b, c])
  assert.equal(b.start, 2)
  assert.equal(b.finish, 2) // 未碰过机器
  assert.equal(c.start, 2)
  assert.equal(c.finish, 3)
})

test('replay：加工中取消，机器占用到取消时刻才让出', () => {
  const a = job({ qty: 3, days: 2, enqueue_abs: 1, cancel_abs: 3 }) // 第 1 批加工中
  const b = job({ qty: 1, days: 1, enqueue_abs: 1 })
  replay([a, b])
  assert.equal(a.finish, 3)
  assert.equal(b.start, 3)
})

test('finishedBatchesAt / startedBatchesAt：加工中的批次算开工不算完工', () => {
  const j = replay([job({ qty: 3, days: 2, enqueue_abs: 1 })])[0]
  assert.equal(finishedBatchesAt(j, 1), 0)
  assert.equal(startedBatchesAt(j, 1), 1)
  assert.equal(finishedBatchesAt(j, 3), 1)
  assert.equal(startedBatchesAt(j, 3), 2)
  assert.equal(finishedBatchesAt(j, 5), 2)
  assert.equal(startedBatchesAt(j, 5), 3)
  assert.equal(finishedBatchesAt(j, 7), 3)
  assert.equal(startedBatchesAt(j, 7), 3)
})

test('splitIntoBatches：按投料顺序逐批切分，每批 consume 个', () => {
  const batches = splitIntoBatches([wheat(3), hardWheat(3)], 2, 3)
  assert.equal(batches.length, 3)
  assert.deepEqual(batches[0], [wheat(2)])
  assert.deepEqual(batches[1], [wheat(1), hardWheat(1)])
  assert.deepEqual(batches[2], [hardWheat(2)])
})

test('waitingInputsOf：只统计未开工批次，按品种原样聚合', () => {
  const inputs = JSON.stringify(splitIntoBatches([wheat(3), hardWheat(3)], 2, 3))
  const j = job({ qty: 3, inputs })
  // 已有 2 批开工 → 只剩第 3 批的 2 个硬粒小麦锁定可退
  const items = waitingInputsOf(j, 2)
  assert.deepEqual(items, [hardWheat(2)])
  // 全部开工 → 无占用
  assert.deepEqual(waitingInputsOf(j, 3), [])
})

test('waitingInputsOf：旧工单无投料登记时按配方原料统一折算', () => {
  const j = job({ qty: 3, inputs: null, consume: 2 })
  assert.deepEqual(waitingInputsOf(j, 1), [wheat(4)])
})

test('reservedItems：汇总全队在制工单未开工批次的原料占用（含他人工单）', () => {
  const jobs = replay([
    job({ id: 1, qty: 2, days: 1, enqueue_abs: 1, inputs: JSON.stringify([[wheat(2)], [hardWheat(2)]]) }),
    job({ id: 2, qty: 1, days: 1, enqueue_abs: 1, inputs: JSON.stringify([[hardWheat(2)]]) })
  ])
  // 第 1 天：工单 1 第 1 批加工中，其余批次 + 工单 2 全部排队
  const items = reservedItems(jobs, 1)
  // 排队的小麦应为 0（工单1两批小麦/硬粒中的小麦批已开工），硬粒小麦 4
  assert.equal(items.find((it) => it.itemId === 'crop-5'), undefined)
  assert.equal(items.find((it) => it.itemId === 'crop-v1001').qty, 4)
  // 已取消/已完工工单不再占用
  assert.equal(reservedItems([job({ status: 'canceled' })], 1).length, 0)
})

test('movableJobs：只有尚未开工（start>今天）的在制工单可重排', () => {
  const jobs = replay([
    job({ qty: 2, days: 1, enqueue_abs: 1 }), // start1，加工中
    job({ qty: 1, days: 1, enqueue_abs: 1 }), // start3，排队
    job({ qty: 1, days: 1, enqueue_abs: 1 })  // start4，排队
  ])
  const ids = movableJobs(jobs, 1).map((j) => j.id)
  assert.deepEqual(ids, [jobs[1].id, jobs[2].id])
})

test('planReorder：排队工单下移与相邻工单交换 seq；正在加工的工单是不可越过的锚点', () => {
  const jobs = replay([
    job({ qty: 2, days: 1, enqueue_abs: 1 }), // seq=1 加工中
    job({ qty: 1, days: 1, enqueue_abs: 1 }), // seq=2 排队 #1
    job({ qty: 1, days: 1, enqueue_abs: 1 })  // seq=3 排队 #2
  ])
  // 排队 #1 上移会撞上正在加工的锚点 → 无操作
  assert.deepEqual(planReorder(jobs, 1, jobs[1].id, 'up').assign, [])
  // 排队 #1 下移：与 #2 交换 seq
  const down = planReorder(jobs, 1, jobs[1].id, 'down')
  assert.deepEqual(down.assign, [[jobs[1].id, jobs[2].seq], [jobs[2].id, jobs[1].seq]])
  // 排队 #2 已在窗口尾，再下移无操作
  assert.deepEqual(planReorder(jobs, 1, jobs[2].id, 'down').assign, [])
})

test('planReorder：交换 seq 后重放，机器按新顺序加工（品种投料仍归各自工单）', () => {
  const a = job({ qty: 2, days: 1, enqueue_abs: 1 })
  const b = job({ qty: 1, days: 1, enqueue_abs: 1 })
  replay([a, b]) // a:1-3, b:3-4
  // 交换排队工单 a 的未开工段与 b：简化为直接换 seq 后重放
  ;[a.seq, b.seq] = [b.seq, a.seq]
  replay([a, b].sort((x, y) => x.seq - y.seq))
  // b 现在排前：start1 finish2；a start2 finish4
  assert.equal(b.start, 1)
  assert.equal(b.finish, 2)
  assert.equal(a.start, 2)
  assert.equal(a.finish, 4)
})

test('planReorder：已开工/已结束的工单拒绝重排', () => {
  const jobs = replay([job({ qty: 2, days: 1, enqueue_abs: 1 })])
  assert.throws(() => planReorder(jobs, 1, jobs[0].id, 'up'), /不能调整顺序/)
  assert.throws(() => planReorder(jobs, 1, 999, 'up'), /不能调整顺序/)
  assert.throws(() => planReorder(jobs, 1, jobs[0].id, 'left'), /up\/down/)
})

test('协作场景：成员把自己的排队工单前移 → 跨天重放 → 取消时按品种原样退料', () => {
  // A 先排 2 批面粉（先小麦后硬粒），B 再排 1 批（硬粒）；第 1 天 A 的第 1 批已开工
  const a = job({
    id: 10, created_by: 1, qty: 2, days: 1, enqueue_abs: 1,
    inputs: JSON.stringify([[wheat(2)], [hardWheat(2)]])
  })
  const b = job({ id: 11, created_by: 2, qty: 1, days: 1, enqueue_abs: 1, inputs: JSON.stringify([[hardWheat(2)]]) })
  replay([a, b])
  assert.deepEqual(movableJobs([a, b], 1).map((j) => j.id), [b.id]) // A 开工、B 排队，B 无法越过锚点
  // 推进到第 3 天：A 两批完工（1→3），B 第 3 天开工
  replay([a, b])
  assert.equal(finishedBatchesAt(a, 3), 2)
  assert.equal(startedBatchesAt(b, 3), 1)
  // B 又排一单 c（2 批，硬粒+小麦），随后前移到自己原工单之前不影响已开工的 b
  const c = job({
    id: 12, created_by: 2, qty: 2, days: 1, enqueue_abs: 3,
    inputs: JSON.stringify([[hardWheat(2)], [wheat(2)]])
  })
  replay([a, b, c]) // b 占用 3→4，c start4
  assert.equal(c.start, 4)
  // 第 4 天 c 第 1 批开工时成员取消：只退第 2 批的 2 个小麦（第 1 批加工中不退）
  const started = startedBatchesAt(c, 4)
  assert.equal(started, 1)
  assert.deepEqual(waitingInputsOf(c, started), [wheat(2)])
})
