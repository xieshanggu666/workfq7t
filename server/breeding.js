import { db } from './db.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 育种参数 =====
export const BREED_GOLD = 25          // 一次杂交试验投入金币
export const PARENT_QTY = 2           // 每个亲本投入的作物数量
export const TRIAL_DAYS = 4           // 试验基准周期（游戏天）
export const START_WATER = 75
export const START_FERT = 75

// ===== 遗传性状图鉴 =====
// 作用对象：
//   plot  —— 播种后的地块生长/收获
//   trial —— 育种试验本身（子代性状会影响它自己的培育）
// care：正性状按品质提升试验养护分，负性状反之
export const TRAITS = {
  highyield: { name: '高产', icon: '🌾', good: true, desc: '收获产量+1，产量类养护加成',
    mods: { harvestYield: 1 }, trial: { care: 8 } },
  droughthardy: { name: '抗旱', icon: '🏜️', good: true, desc: '水分流失减半，干旱不停长，试验耗水减少',
    mods: { waterDecayMul: 0.5, resistDrought: true }, trial: { waterDecayMul: 0.5, resistDrought: true, care: 6 } },
  frosthardy: { name: '抗寒', icon: '❄️', good: true, desc: '霜冻/严寒/暴雪下仍可缓慢生长，试验少受冻害',
    mods: { resistCold: true }, trial: { resistCold: true, coldMul: 0.4, care: 6 } },
  pestresist: { name: '抗虫', icon: '🛡️', good: true, desc: '不易生虫，暴雨虫害天气试验保健康',
    mods: { pestChanceMul: 0.25 }, trial: { pestResist: true, care: 6 } },
  fastgrow: { name: '速生', icon: '⚡', good: true, desc: '有小概率一天长两阶，成熟更快',
    mods: { bonusGrowChance: 0.22 }, trial: { bonusGrowChance: 0.25, care: 6 } },
  giant: { name: '巨型', icon: '📏', good: true, desc: '售价 +45%，但生长多 2 天',
    mods: { priceMul: 1.45, daysAdd: 2 }, trial: { care: 8 } },
  weak: { name: '脆弱', icon: '🥀', bad: true, desc: '天气伤害更高，试验健康更易受损',
    mods: { weatherMul: 1.5 }, trial: { weatherMul: 1.5, care: -6 } },
  lowyield: { name: '低产', icon: '📉', bad: true, desc: '收获产量-1（保底 1），试验品质略降',
    mods: { harvestYield: -1 }, trial: { care: -6 } }
}
export const TRAIT_KEYS = Object.keys(TRAITS)
const GOOD_KEYS = TRAIT_KEYS.filter((k) => TRAITS[k].good)
const BAD_KEYS = TRAIT_KEYS.filter((k) => TRAITS[k].bad)
const TRAIT_PREFIX = {
  highyield: '丰产', droughthardy: '耐旱', frosthardy: '耐寒', pestresist: '抗虫',
  fastgrow: '速生', giant: '巨型', weak: '纤弱', lowyield: '低产'
}

// ===== 引用解析：'base:<id>' 基础作物 / 'var:<id>' 杂交品种（按农场隔离）=====
export function resolveRef(farmId, ref) {
  const [kind, idStr] = String(ref || '').split(':')
  const id = Number(idStr)
  if (kind === 'var') {
    const v = q1('SELECT * FROM crop_varieties WHERE farm_id=? AND id=?', farmId, id)
    if (v) return { kind: 'var', id, row: { ...v, traits: JSON.parse(v.traits || '[]') } }
  }
  const b = q1('SELECT * FROM crops WHERE farm_id=? AND id=?', farmId, id)
  if (b) return { kind: 'base', id, row: { ...b, base_id: b.id, traits: [], gen: 0 } }
  return null
}

// 统一「作物视图」：基础作物或品种，返回给地块/收获逻辑使用
export function cropLike(farmId, cropId) {
  const n = Number(cropId)
  if (n >= 1000) {
    const v = q1('SELECT * FROM crop_varieties WHERE farm_id=? AND id=?', farmId, n)
    if (!v) return null
    return {
      id: v.id, base_id: v.base_id, name: v.name, days: v.days, season: v.season,
      price: v.price, seedPrice: v.seed_price, sprite: v.sprite,
      traits: JSON.parse(v.traits || '[]'), gen: v.gen, isVariety: true
    }
  }
  const b = q1('SELECT * FROM crops WHERE farm_id=? AND id=?', farmId, n)
  return b ? { ...b, base_id: b.id, traits: [], gen: 0, isVariety: false } : null
}

// 库存中某作物（含所有本源相同的杂交品种）总持有量
export function totalCropStock(farmId, baseId) {
  const bases = q1('SELECT qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, 'crop-' + baseId)?.qty || 0
  let vars = 0
  for (const v of q('SELECT id FROM crop_varieties WHERE farm_id=? AND base_id=?', farmId, baseId)) {
    vars += q1('SELECT qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, 'crop-v' + v.id)?.qty || 0
  }
  return bases + vars
}

function traitsOf(farmId, ref) {
  const r = resolveRef(farmId, ref)
  return r ? r.row.traits || [] : []
}

// 品种签名：本源 + 排序性状。同农场同签名品种只建一次（重复育成稳定复现）
function sigOf(baseId, traitSet) {
  return 'b' + baseId + ':' + [...traitSet].sort().join(',')
}

function clampDays(d) { return Math.max(2, Math.min(12, d)) }

// ===== 性状遗传：双方共有高概率继承，单方有较低概率；少量突变 =====
function inheritTraits(tA, tB) {
  const setA = new Set(tA)
  const setB = new Set(tB)
  const out = new Set()
  for (const k of TRAIT_KEYS) {
    const inA = setA.has(k)
    const inB = setB.has(k)
    let p = 0
    if (inA && inB) p = 0.85
    else if (inA || inB) p = 0.4
    else p = 0.015                      // 无中生有的自然突变
    if (Math.random() < p) out.add(k)
  }
  // 基础作物（双方均无性状）杂交更容易出优良突变，给一次额外机会
  if (setA.size + setB.size === 0 && out.size === 0 && Math.random() < 0.35) {
    out.add(GOOD_KEYS[Math.floor(Math.random() * GOOD_KEYS.length)])
  }
  // 负面突变：正性状越多，越有小概率伴随缺陷
  const goods = [...out].filter((k) => TRAITS[k].good)
  if (goods.length >= 2 && Math.random() < 0.18) {
    out.add(BAD_KEYS[Math.floor(Math.random() * BAD_KEYS.length)])
  }
  // 最多保留 4 个性状：正性状优先，多余的随机丢
  const keys = [...out]
  if (keys.length > 4) {
    keys.sort((a, b) => Number(TRAITS[b].good) - Number(TRAITS[a].good) || Math.random() - 0.5)
    return keys.slice(0, 4)
  }
  return keys
}

// 品种命名：性状前缀 + 本源名；跨本源杂交标注为「融合」（农场内唯一）
function varietyName(farmId, baseCrop, traits, crossBase) {
  const prefix = traits.map((k) => TRAIT_PREFIX[k]).join('')
  const core = crossBase ? '融合' + baseCrop.name : baseCrop.name
  let name = (prefix || '改良') + core
  // 撞名时追加编号
  let n = 2
  while (q1('SELECT id FROM crop_varieties WHERE farm_id=? AND name=?', farmId, name)) {
    name = (prefix || '改良') + core + '·' + n++
  }
  return name
}

// 建立（或复用同农场同签名的）杂交品种；返回品种行
function createVariety(farmId, baseId, traits, parentA, parentB, currentAbs) {
  const traitsSorted = [...traits].sort()
  const sig = sigOf(baseId, traitsSorted)
  const exist = q1('SELECT * FROM crop_varieties WHERE farm_id=? AND sig=?', farmId, sig)
  if (exist) return { ...exist, traits: JSON.parse(exist.traits) }
  const base = q1('SELECT * FROM crops WHERE farm_id=? AND id=?', farmId, baseId)
  const gA = genOf(farmId, parentA)
  const gB = genOf(farmId, parentB)
  const crossBase = resolveRef(farmId, parentA).row.base_id !== resolveRef(farmId, parentB).row.base_id
  let days = base.days
  let price = Math.round(base.price * 1.05)       // 杂交基础溢价
  let seedPrice = Math.round(base.seedPrice * 1.1)
  for (const k of traitsSorted) {
    const m = TRAITS[k].mods || {}
    if (m.daysAdd) days += m.daysAdd
    if (m.priceMul) price = Math.round(price * m.priceMul)
    if (TRAITS[k].good && !m.priceMul) price += 2
    if (TRAITS[k].bad) price = Math.max(1, price - 2)
    seedPrice = Math.max(1, Math.round(seedPrice * (TRAITS[k].good ? 1.08 : 0.95)))
  }
  const name = varietyName(farmId, base, traitsSorted, crossBase)
  const r = run(
    `INSERT INTO crop_varieties
     (farm_id,base_id,name,sprite,season,days,price,seed_price,traits,sig,parent_a,parent_b,gen,created_abs)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    farmId, baseId, name, base.sprite, base.season, clampDays(days), price, seedPrice,
    JSON.stringify(traitsSorted), sig, parentA, parentB, Math.max(gA, gB) + 1, currentAbs
  )
  return cropLike(farmId, r.lastInsertRowid)
}
function genOf(farmId, ref) {
  const r = resolveRef(farmId, ref)
  return r ? (r.row.gen || 0) : 0
}

// 同时可进行的试验数：育种棚等级即容量
export function breedCapacity(labLevel = 1) {
  return Math.max(1, labLevel)
}

function runningCount(farmId) {
  return q1("SELECT COUNT(*) c FROM breeding_trials WHERE farm_id=? AND status='running'", farmId).c
}

// 库存里取某亲本引用对应的库存项 id
function stackForRef(farmId, ref) {
  const [kind, id] = ref.split(':')
  const itemId = kind === 'var' ? 'crop-v' + id : 'crop-' + id
  return q1('SELECT * FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)
}

// ===== 开始试验：投入两批作物（各 PARENT_QTY 个）+ 金币 =====
export function startTrial({ parentA, parentB, labLevel, currentAbs, farmId }) {
  const ra = resolveRef(farmId, parentA)
  const rb = resolveRef(farmId, parentB)
  if (!ra || !rb) throw Object.assign(new Error('亲本作物不存在'), { status: 400 })
  if (runningCount(farmId) >= breedCapacity(labLevel)) {
    throw Object.assign(new Error(`育种棚已满（${runningCount(farmId)}/${breedCapacity(labLevel)} 组试验），等试验成熟或取消一组`), { status: 400 })
  }
  const needA = parentA === parentB ? PARENT_QTY * 2 : PARENT_QTY
  const needB = PARENT_QTY
  const stA = stackForRef(farmId, parentA)
  const stB = stackForRef(farmId, parentB)
  if ((stA?.qty || 0) < needA) throw Object.assign(new Error(`父本不足：需要 ${ra.row.name} ×${needA}`), { status: 400 })
  if (parentA !== parentB && (stB?.qty || 0) < needB) {
    throw Object.assign(new Error(`母本不足：需要 ${rb.row.name} ×${needB}`), { status: 400 })
  }
  const gold = q1('SELECT gold FROM player WHERE farm_id=?', farmId).gold
  if (gold < BREED_GOLD) throw Object.assign(new Error('金币不足，无法开始杂交试验'), { status: 400 })

  // 跨种杂交：子代本源在两个亲本本源间随机取一种
  const baseA = ra.row.base_id
  const baseB = rb.row.base_id
  const childBase = baseA === baseB ? baseA : (Math.random() < 0.5 ? baseA : baseB)
  const childTraits = inheritTraits(ra.row.traits || [], rb.row.traits || [])

  db.exec('BEGIN IMMEDIATE')
  try {
    run('UPDATE inventory SET qty=qty-? WHERE id=?', needA, stA.id)
    if (parentA !== parentB) run('UPDATE inventory SET qty=qty-? WHERE id=?', needB, stB.id)
    run('DELETE FROM inventory WHERE qty<=0 AND farm_id=?', farmId)
    run('UPDATE player SET gold=gold-? WHERE farm_id=?', BREED_GOLD, farmId)
    const r = run(
      `INSERT INTO breeding_trials
       (farm_id,parent_a,parent_b,parent_a_name,parent_a_icon,parent_a_traits,
        parent_b_name,parent_b_icon,parent_b_traits,base_id,traits_json,
        status,water,fert,health,start_abs,days_total)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'running', ?,?,100,?,?)`,
      farmId, parentA, parentB, ra.row.name, ra.row.sprite, JSON.stringify(ra.row.traits || []),
      rb.row.name, rb.row.sprite, JSON.stringify(rb.row.traits || []),
      childBase, JSON.stringify(childTraits),
      START_WATER, START_FERT, currentAbs, TRIAL_DAYS
    )
    db.exec('COMMIT')
    return { ok: true, id: r.lastInsertRowid, childBase, traits: childTraits }
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束，忽略 */ }
    throw e
  }
}

// ===== 养护：浇水/施肥/照料（照料恢复健康并提升养护分）=====
export function careTrial(farmId, id, action) {
  const t = q1("SELECT * FROM breeding_trials WHERE farm_id=? AND id=? AND status='running'", farmId, id)
  if (!t) throw Object.assign(new Error('试验不存在或已结束'), { status: 400 })
  if (action === 'water') {
    run('UPDATE breeding_trials SET water=100 WHERE id=?', id)
  } else if (action === 'fert') {
    run('UPDATE breeding_trials SET fert=100 WHERE id=?', id)
  } else if (action === 'tend') {
    run('UPDATE breeding_trials SET health=100, care=MIN(100, care+12), care_count=care_count+1 WHERE id=?', id)
  } else {
    throw Object.assign(new Error('未知养护操作'), { status: 400 })
  }
  return { ok: true }
}

// 取消试验：亲本已消耗不退（与加工中批次同理）
export function cancelTrial(farmId, id) {
  const r = run("UPDATE breeding_trials SET status='canceled', finish_abs=(SELECT abs_day FROM player WHERE farm_id=?) WHERE farm_id=? AND id=? AND status='running'",
    farmId, farmId, id)
  if (!r.changes) throw Object.assign(new Error('试验不存在或已结束'), { status: 400 })
  return { ok: true }
}

// 试验列表（附带亲本/子代性状详情与进度）
export function listTrials(farmId) {
  const rows = q("SELECT * FROM breeding_trials WHERE farm_id=? AND status IN ('running','done','failed') ORDER BY id DESC LIMIT 30", farmId)
  return rows.map((t) => ({
    ...t,
    traits: JSON.parse(t.traits_json || '[]'),
    parent_a_traits: JSON.parse(t.parent_a_traits || '[]'),
    parent_b_traits: JSON.parse(t.parent_b_traits || '[]'),
    remain: Math.max(0, t.days_total - t.progress),
    variety: t.result_variety_id ? cropLike(farmId, t.result_variety_id) : null
  }))
}

function clamp100(v) { return Math.max(0, Math.min(100, v)) }

// 试验完成：建立/复用品种，发放种子，经验
function finishTrial(farmId, t, currentAbs, logs) {
  const variety = createVariety(farmId, t.base_id, JSON.parse(t.traits_json || '[]'), t.parent_a, t.parent_b, currentAbs)
  // 种子数：基础 2，养护分每 25 点 +1，封顶 5
  let seeds = 2 + Math.floor(t.care / 25)
  if (t.care >= 100) seeds += 0
  seeds = Math.min(5, seeds)
  const itemId = 'seed-v' + variety.id
  const exist = q1('SELECT qty FROM inventory WHERE farm_id=? AND item_id=?', farmId, itemId)
  if (exist) run('UPDATE inventory SET qty=qty+? WHERE id=?', seeds, exist.id)
  else run('INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (?,?,?,?,?)', farmId, itemId, variety.name + '种子', 'seed', seeds)
  run(`UPDATE breeding_trials SET status='done', result_variety_id=?, result_seeds=?, finish_abs=? WHERE id=?`,
    variety.id, seeds, currentAbs, t.id)
  run('UPDATE player SET exp=exp+4 WHERE farm_id=?', farmId)
  const traitTxt = (JSON.parse(t.traits_json || '[]')).map((k) => TRAITS[k].icon + TRAITS[k].name).join(' ')
  logs.push(`🧬 杂交试验 #${t.id} 成功：培育出「${variety.name}」种子 ×${seeds}${traitTxt ? '（' + traitTxt + '）' : ''}`)
}

// ===== 逐日结算（在 advanceDay 事务内调用，不另开事务）=====
// weather：当日 settleWeather 的结果 { type, severity, mods }
// 结构与地块结算对齐：水分/肥力自然消耗，恶劣天气造成健康损失，
// 条件良好则发育推进 + 养护分累积，健康归零失败，发育成熟即产出种子。
export function settleBreeding({ type, severity, mods }, currentAbs, farmId) {
  const logs = []
  const trials = q("SELECT * FROM breeding_trials WHERE farm_id=? AND status='running'", farmId)
  for (const t of trials) {
    const traits = JSON.parse(t.traits_json || '[]')
    const has = (k) => traits.includes(k)

    // —— 水分/肥力消耗（抗旱减半）——
    const wMul = has('droughthardy') ? 0.5 : 1
    let water = clamp100(t.water - (12 + Math.round(Math.random() * 10)) * wMul + (mods.waterAdd || 0))
    let fert = clamp100(t.fert - (8 + Math.round(Math.random() * 8)) + (mods.fertAdd || 0))
    if (mods.setWater != null) water = mods.setWater

    // —— 健康：恶劣天气伤害（抗寒/抗虫减免，脆弱加成）——
    let dmg = Math.abs(mods.plantDamage || 0)
    if (has('frosthardy') && (type === 'frost' || type === 'freeze' || type === 'blizzard')) dmg *= 0.4
    if (has('pestresist') && type === 'storm') dmg *= 0.5
    if (has('weak')) dmg *= 1.5
    // 虫害自然侵蚀健康
    if (Math.random() < 0.2 && !has('pestresist')) dmg += 3
    let health = clamp100(t.health - Math.round(dmg) + (mods.plantRecover || 0))

    // —— 发育判定 ——
    const bad = (mods.weatherBad || severity > 0)
    let blocked = mods.growthBlock
    if (blocked) {
      if (has('frosthardy') && (type === 'frost' || type === 'freeze' || type === 'blizzard')) blocked = false
      if (has('droughthardy') && type === 'drought') blocked = false
    }
    const conditions = water >= 30 && fert >= 30
    let progress = t.progress
    let care = t.care
    let blockedDays = t.blocked_days
    if (conditions && !blocked && health > 0) {
      let step = 1
      const bonus = traits.includes('fastgrow') ? 0.25 : 0
      if (Math.random() < bonus) step = 2
      progress = Math.min(t.days_total, progress + step)
      // 养护分：四维越好累积越快；性状加成
      let gain = 6 + Math.round((water + fert + health) / 30)
      for (const k of traits) {
        const c = TRAITS[k].trial?.care
        if (c) gain += c > 0 ? Math.round(c / 3) : 1
      }
      care = Math.min(100, care + Math.max(2, gain))
    } else {
      blockedDays += 1
    }

    run('UPDATE breeding_trials SET water=?,fert=?,health=?,progress=?,care=?,blocked_days=? WHERE id=?',
      water, fert, health, progress, care, blockedDays, t.id)

    if (health <= 0) {
      run("UPDATE breeding_trials SET status='failed', finish_abs=? WHERE id=?", currentAbs, t.id)
      logs.push(`🥀 杂交试验 #${t.id} 因健康耗尽失败（${t.parent_a_name} × ${t.parent_b_name}）`)
      continue
    }
    if (progress >= t.days_total) finishTrial(farmId, { ...t, traits_json: t.traits_json, care }, currentAbs, logs)
    else if (blocked && bad) logs.push(`⚠️ 杂交试验 #${t.id} 受天气影响暂停发育（健康 ${Math.round(health)}）`)
  }
  return logs
}
