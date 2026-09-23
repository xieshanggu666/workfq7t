// ===== 灌溉纯逻辑：供水网络划分 + 统一分水调度 =====
// 不依赖数据库（便于单测）；DB 读写见 server/irrigation.js

export const BASE_DAILY_USE = 18 // 作物日均耗水期望（每日 12+rand(0..12) 的均值），调度估算用

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// 供水网络：启用中的蓄水池+水渠按 4 连通并查集分组。
// 同组多座蓄水池属于同一供水网络，每日结算时统一分水；
// 停用/拆除的设施不参与分组，断流与恢复都由每次实时重算自然生效。
export function buildNetworks(facilities, plots) {
  const nodes = facilities.filter((f) => f.active)
  const parent = new Map(nodes.map((n) => [n.id, n.id]))
  const find = (a) => {
    while (parent.get(a) !== a) { parent.set(a, parent.get(parent.get(a))); a = parent.get(a) }
    return a
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  const at = new Map(nodes.map((n) => [`${n.x},${n.y}`, n]))
  for (const n of nodes) {
    for (const [dx, dy] of [[1, 0], [0, 1]]) { // 只查右/下，避免重复合并
      const m = at.get(`${n.x + dx},${n.y + dy}`)
      if (m) union(n.id, m.id)
    }
  }
  const groups = new Map()
  for (const n of nodes) {
    const root = find(n.id)
    if (!groups.has(root)) groups.set(root, { reservoirs: [], canalIds: [], cells: [] })
    const g = groups.get(root)
    if (n.kind === 'reservoir') g.reservoirs.push(n)
    else g.canalIds.push(n.id)
    g.cells.push([n.x, n.y])
  }
  const plotAt = new Map(plots.map((p) => [`${p.x},${p.y}`, p]))
  const networks = []
  for (const g of groups.values()) {
    // 地块与网络内任一设施（蓄水池/水渠）相邻即接通，不再向外延伸
    const plotIds = new Set()
    for (const [cx, cy] of g.cells) {
      for (const [dx, dy] of DIRS) {
        const p = plotAt.get(`${cx + dx},${cy + dy}`)
        if (p) plotIds.add(p.id)
      }
    }
    networks.push({
      reservoirs: g.reservoirs.sort((a, b) => a.id - b.id),
      canalIds: g.canalIds.sort((a, b) => a - b),
      plotIds
    })
  }
  // 稳定编号：按网络内最小设施 id 排序，便于前端展示与报告对齐
  const minId = (n) => Math.min(...n.reservoirs.map((r) => r.id), ...n.canalIds)
  networks.sort((a, b) => minId(a) - minId(b))
  networks.forEach((n, i) => { n.id = i + 1 })
  return networks
}

// 地块次日耗水估算：基础耗水 × 品种性状修正（抗旱减半/脆弱放大）+ 天气额外蒸发。
// 调度时据此判断各地块「距离缺水还有多远」，结合天气与品种耗水安排供水顺序。
export function estDailyUse(cropTraits, mods, TRAITS) {
  const t = new Set(cropTraits || [])
  const weakMul = TRAITS?.weak?.mods?.weatherMul ?? 1.5
  let mul = 1
  if (t.has('droughthardy')) mul *= TRAITS?.droughthardy?.mods?.waterDecayMul ?? 0.5
  if (t.has('weak')) mul *= weakMul
  const evap = Math.max(0, -(mods?.waterAdd || 0)) * (t.has('weak') ? weakMul : 1)
  return Math.round(BASE_DAILY_USE * mul + evap)
}

// 统一分水调度：同一网络内多座蓄水池汇成统一水池，按
//   保水优先级 高→低 → 预计最快缺水者优先（当前水分-预计耗水）→ 水分低者优先
// 的顺序把有限水量浇到各地块的目标水分（irr_target，0 表示不自动浇水），耗尽即止；
// 余水按比例回写各池（统一分水后各池水位趋于均衡）。
// 返回 { give, reservoirWater, report, totals, waterNow }，全部为数据不写库。
export function planAllocation({ networks, plots, cropOf, mods, traitsDef, cap }) {
  const waterNow = new Map(plots.map((p) => [p.id, p.water]))
  const give = new Map()           // plotId -> 总供水量（跨网络累计）
  const reservoirWater = new Map() // reservoirId -> 结算后水量
  const shortByPlot = new Map()    // plotId -> 最终缺口（后续网络可能补足）
  const report = { networks: [], totals: { fed: 0, used: 0, shortCount: 0, shortAmount: 0 } }

  for (const net of networks) {
    let pool = net.reservoirs.reduce((s, r) => s + r.water, 0)
    const poolBefore = pool
    // 只浇有作物且低于目标水分的地块
    const targets = plots
      .filter((p) => net.plotIds.has(p.id) && p.crop_id && waterNow.get(p.id) < (p.irr_target ?? 100))
      .map((p) => {
        const crop = cropOf(p.crop_id)
        return { plot: p, crop, target: p.irr_target ?? 100, est: estDailyUse(crop?.traits, mods, traitsDef) }
      })
      .sort((a, b) =>
        (b.plot.irr_priority - a.plot.irr_priority) ||
        ((waterNow.get(a.plot.id) - a.est) - (waterNow.get(b.plot.id) - b.est)) ||
        (waterNow.get(a.plot.id) - waterNow.get(b.plot.id)) ||
        (a.plot.id - b.plot.id))

    const netReport = { id: net.id, poolBefore, poolAfter: pool, reservoirs: [], plots: [] }
    for (const t of targets) {
      const cur = waterNow.get(t.plot.id)
      const need = t.target - cur
      const g = Math.max(0, Math.min(need, pool))
      if (g > 0) {
        give.set(t.plot.id, (give.get(t.plot.id) || 0) + g)
        waterNow.set(t.plot.id, cur + g)
        pool -= g
      }
      const short = need - g
      if (short > 0) shortByPlot.set(t.plot.id, short)
      else shortByPlot.delete(t.plot.id)
      netReport.plots.push({
        plotId: t.plot.id, x: t.plot.x, y: t.plot.y,
        crop: t.crop?.name || '', sprite: t.crop?.sprite || '',
        priority: t.plot.irr_priority, target: t.target, est: t.est,
        before: Math.round(cur), got: g, after: Math.round(cur + g), short
      })
    }

    // 余水按比例回写各蓄水池，舍入差额补到水量最大的池子
    if (poolBefore > 0 && pool !== poolBefore) {
      const ratio = pool / poolBefore
      const sorted = [...net.reservoirs].sort((a, b) => b.water - a.water || a.id - b.id)
      let assigned = 0
      for (const r of sorted) {
        const w = Math.min(cap, Math.max(0, Math.round(r.water * ratio)))
        reservoirWater.set(r.id, w)
        assigned += w
      }
      const diff = pool - assigned
      if (diff !== 0 && sorted.length) {
        const top = sorted[0]
        reservoirWater.set(top.id, Math.min(cap, Math.max(0, reservoirWater.get(top.id) + diff)))
      }
    }
    netReport.poolAfter = pool
    netReport.reservoirs = net.reservoirs.map((r) => ({
      id: r.id, x: r.x, y: r.y, before: r.water, after: reservoirWater.get(r.id) ?? r.water
    }))
    report.networks.push(netReport)
  }

  report.totals.fed = give.size
  report.totals.used = [...give.values()].reduce((s, v) => s + v, 0)
  report.totals.shortCount = shortByPlot.size
  report.totals.shortAmount = [...shortByPlot.values()].reduce((s, v) => s + v, 0)
  return { give, reservoirWater, report, totals: report.totals, waterNow }
}
