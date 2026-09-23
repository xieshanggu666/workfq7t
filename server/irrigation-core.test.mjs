import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildNetworks, estDailyUse, planAllocation, BASE_DAILY_USE } from './irrigation-core.js'

const CAP = 150
const TRAITS = {
  droughthardy: { mods: { waterDecayMul: 0.5 } },
  weak: { mods: { weatherMul: 1.5 } }
}

// —— 测试数据构造 ——
const res = (id, x, y, water = 0, active = 1) => ({ id, kind: 'reservoir', x, y, water, active })
const canal = (id, x, y, active = 1) => ({ id, kind: 'canal', x, y, water: 0, active })
const plot = (id, x, y, over = {}) => ({
  id, x, y, crop_id: 1, water: 50, irr_priority: 1, irr_target: 100, ...over
})
const cropOf = () => ({ name: '萝卜', sprite: '🥕', traits: [] })
const plan = (networks, plots, mods = null) =>
  planAllocation({ networks, plots, cropOf, mods, traitsDef: TRAITS, cap: CAP })

test('buildNetworks：连通的多座蓄水池归入同一网络，停用的设施不参与', () => {
  const facilities = [
    res(1, 0, 0, 100), canal(2, 1, 0), canal(3, 2, 0), res(4, 3, 0, 50), // 网络 A：两池相连
    res(5, 6, 0, 30),                                                    // 网络 B：孤立池
    canal(6, 4, 0, 0)                                                    // 停用水渠：不连接 A 与 B
  ]
  const plots = [plot(10, 0, 1), plot(11, 3, 1), plot(12, 6, 1)]
  const nets = buildNetworks(facilities, plots)
  assert.equal(nets.length, 2)
  const a = nets.find((n) => n.reservoirs.some((r) => r.id === 1))
  const b = nets.find((n) => n.reservoirs.some((r) => r.id === 5))
  assert.deepEqual(a.reservoirs.map((r) => r.id), [1, 4])
  assert.deepEqual(a.canalIds, [2, 3])
  assert.ok(a.plotIds.has(10) && a.plotIds.has(11) && !a.plotIds.has(12))
  assert.ok(b.plotIds.has(12))
})

test('buildNetworks：拆除（行删除）与停用（active=0）后重算，网络随之变化', () => {
  const base = [res(1, 0, 0, 100), canal(2, 1, 0), res(3, 2, 0, 50)]
  assert.equal(buildNetworks(base, []).length, 1)                 // 连通：1 个网络
  assert.equal(buildNetworks(base.filter((f) => f.id !== 2), []).length, 2) // 拆除水渠：拆成 2 个
  const disabled = [res(1, 0, 0, 100), canal(2, 1, 0, 0), res(3, 2, 0, 50)]
  assert.equal(buildNetworks(disabled, []).length, 2)             // 停用水渠：同样拆成 2 个
})

test('planAllocation：同一网络统一分水，余水按比例回写各池且总量守恒', () => {
  const nets = buildNetworks([res(1, 0, 0, 100), canal(2, 1, 0), res(3, 2, 0, 50)], [])
  nets[0].plotIds = new Set([10])
  const plots = [plot(10, 0, 1, { water: 10 })] // 需水 90，池共 150，余 60
  const { give, reservoirWater, totals } = plan(nets, plots)
  assert.equal(give.get(10), 90)
  assert.equal(totals.used, 90)
  const left = [...reservoirWater.values()].reduce((s, v) => s + v, 0)
  assert.equal(left, 60) // 150 - 90
  // 按比例回写：100:50 → 40:20
  assert.equal(reservoirWater.get(1), 40)
  assert.equal(reservoirWater.get(3), 20)
})

test('planAllocation：水量不足时保水优先级高者先供水，同级预计最快缺水者优先', () => {
  const nets = buildNetworks([res(1, 0, 0, 40)], [])
  nets[0].plotIds = new Set([10, 11, 12])
  const plots = [
    plot(10, 0, 1, { water: 10, irr_priority: 0, irr_target: 40 }),  // 低优先级
    plot(11, 1, 1, { water: 10, irr_priority: 2, irr_target: 40 }),  // 高优先级，先供
    plot(12, 2, 1, { water: 10, irr_priority: 2, irr_target: 40 })   // 高优先级，后到
  ]
  const { give, totals, report } = plan(nets, plots)
  assert.equal(give.get(11), 30) // 池水 40 先浇足高优先级
  assert.equal(give.get(12), 10) // 余水只够浇一部分
  assert.equal(give.get(10), undefined)
  assert.equal(totals.shortCount, 2) // 10 与 12 均未浇足
  assert.equal(report.totals.shortAmount, 50) // 缺 30 + 20
})

test('planAllocation：同级按预计耗水紧急度排序（抗旱品种耗水低、后排）', () => {
  const nets = buildNetworks([res(1, 0, 0, 20)], [])
  nets[0].plotIds = new Set([10, 11])
  const plots = [plot(10, 0, 1, { water: 50 }), plot(11, 1, 1, { water: 50 })]
  const hardy = (id) => id === 11
  const { give } = planAllocation({
    networks: nets, plots, mods: null, traitsDef: TRAITS, cap: CAP,
    cropOf: (id) => ({ name: 'c', sprite: 'x', traits: hardy(id) ? ['droughthardy'] : [] })
  })
  assert.equal(give.get(10), 20)          // 普通品种（预计耗水高）先浇
  assert.equal(give.get(11), undefined)   // 抗旱品种靠后，本轮无水可分
})

test('planAllocation：只浇到目标水分；目标 0 不自动浇水', () => {
  const nets = buildNetworks([res(1, 0, 0, 150)], [])
  nets[0].plotIds = new Set([10, 11])
  const plots = [
    plot(10, 0, 1, { water: 40, irr_target: 60 }),
    plot(11, 1, 1, { water: 40, irr_target: 0 })
  ]
  const { give, totals } = plan(nets, plots)
  assert.equal(give.get(10), 20) // 浇到 60 即止
  assert.equal(give.get(11), undefined)
  assert.equal(totals.shortCount, 0)
})

test('planAllocation：跨网络地块不重复超浇，第二网络只补到目标', () => {
  const nets = buildNetworks([res(1, 0, 0, 100), res(2, 5, 0, 100)], [])
  nets[0].plotIds = new Set([10])
  nets[1].plotIds = new Set([10])
  const plots = [plot(10, 0, 1, { water: 30, irr_target: 80 })]
  const { give, totals } = plan(nets, plots)
  assert.equal(give.get(10), 50) // 两个网络合计也只浇到目标 80
  assert.equal(totals.used, 50)
})

test('estDailyUse：品种性状与天气蒸发共同影响耗水估算', () => {
  assert.equal(estDailyUse([], null, TRAITS), BASE_DAILY_USE)
  assert.equal(estDailyUse(['droughthardy'], null, TRAITS), Math.round(BASE_DAILY_USE * 0.5))
  assert.equal(estDailyUse(['weak'], null, TRAITS), Math.round(BASE_DAILY_USE * 1.5))
  // 干旱天气（waterAdd 为负）增加蒸发量；脆弱品种放大天气损耗
  assert.equal(estDailyUse([], { waterAdd: -25 }, TRAITS), BASE_DAILY_USE + 25)
  assert.equal(estDailyUse(['weak'], { waterAdd: -20 }, TRAITS), Math.round(BASE_DAILY_USE * 1.5 + 30))
})
