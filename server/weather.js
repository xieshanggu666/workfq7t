import { db } from './db.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const q1 = (sql, ...p) => db.prepare(sql).get(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 天气图鉴 =====
// effects 为「每 1 级 severity、完全无防护」时的每日基准影响
export const TYPES = {
  sunny:    { name: '晴天', icon: '☀️', bad: false, desc: '阳光充足，作物与动物状态自然恢复' },
  rain:     { name: '降雨', icon: '🌧️', bad: false, desc: '雨水滋润，耕地自动浇满水' },
  drought:  { name: '干旱', icon: '🏜️', bad: true,  desc: '水分大量流失，作物停止生长', effects: { water: 25, animal: 4, growthBlock: true } },
  storm:    { name: '暴雨', icon: '⛈️', bad: true,  desc: '冲走肥力、引发虫害，可能打坏作物', effects: { fert: 20, animal: 5, pest: 1, regress: 0.15, flood: true } },
  frost:    { name: '霜冻', icon: '🌨️', bad: true,  desc: '光照骤减，作物停止生长，动物受冻', effects: { light: 30, animal: 8, growthBlock: true } },
  heatwave: { name: '酷暑', icon: '🔥', bad: true,  desc: '水分加速蒸发，动物健康受损', effects: { water: 20, animal: 10 } },
  blizzard: { name: '暴雪', icon: '❄️', bad: true,  desc: '光照被遮蔽，动物健康大幅下降', effects: { light: 35, animal: 12, growthBlock: true } },
  freeze:   { name: '严寒', icon: '🥶', bad: true,  desc: '作物停止生长，动物瑟瑟发抖', effects: { light: 20, animal: 10, growthBlock: true } },
  wind:     { name: '大风', icon: '💨', bad: true,  desc: '刮走肥力，可能吹倒作物', effects: { fert: 15, animal: 3, regress: 0.1 } }
}

// 各季节天气概率表（权重）：春夏秋冬
const SEASON_TABLE = [
  [['sunny', 42], ['rain', 24], ['wind', 14], ['frost', 20]],
  [['sunny', 38], ['rain', 14], ['storm', 16], ['drought', 16], ['heatwave', 16]],
  [['sunny', 42], ['rain', 16], ['wind', 18], ['frost', 24]],
  [['sunny', 34], ['blizzard', 26], ['freeze', 24], ['wind', 16]]
]

// 每日全防护消耗：金币 severity*10 + 物资 severity*1
export const upkeepOf = (ev) => ({ gold: ev.severity * 10, mat: ev.severity })

// 为指定农场的指定日期生成天气并持久化；当天已有记录或仍有未结束事件则直接返回
export function ensureWeather(season, day, absDay, farmId) {
  const active = q1('SELECT * FROM weather_events WHERE farm_id=? AND done=0 ORDER BY abs_day LIMIT 1', farmId)
  if (active) return active
  const dup = q1('SELECT * FROM weather_events WHERE farm_id=? AND abs_day=?', farmId, absDay)
  if (dup) return dup
  const table = SEASON_TABLE[season % 4]
  const total = table.reduce((s, [, w]) => s + w, 0)
  let roll = Math.random() * total
  let type = 'sunny'
  for (const [t, w] of table) { roll -= w; if (roll <= 0) { type = t; break } }
  const def = TYPES[type]
  const severity = def.bad ? 1 + Math.floor(Math.random() * 3) : 0
  const duration = def.bad ? Math.min(3, 1 + Math.floor(Math.random() * (severity + 1))) : 1
  run(`INSERT INTO weather_events (farm_id,season,day,abs_day,type,name,icon,duration,severity)
       VALUES (?,?,?,?,?,?,?,?,?)`, farmId, season, day, absDay, type, def.name, def.icon, duration, severity)
  return q1('SELECT * FROM weather_events WHERE farm_id=? AND abs_day=?', farmId, absDay)
}

// 当前天气（含未结束的持续事件）；无事件时返回虚拟晴天
export function currentWeather(farmId) {
  const ev = q1('SELECT * FROM weather_events WHERE farm_id=? AND done=0 ORDER BY abs_day LIMIT 1', farmId)
  if (!ev) {
    return { id: 0, type: 'sunny', name: TYPES.sunny.name, icon: TYPES.sunny.icon, severity: 0, duration: 1, settled_days: 0, protect_gold: 0, protect_mat: 0, bad: false, upkeepGold: 0, upkeepMat: 0, desc: TYPES.sunny.desc }
  }
  const def = TYPES[ev.type] || TYPES.sunny
  const up = upkeepOf(ev)
  return { ...ev, bad: !!def.bad, desc: def.desc, upkeepGold: up.gold, upkeepMat: up.mat }
}

// 结算指定农场当前天气事件的一天，返回 { mods, logs, type, severity }
// mods 为对当日地块/动物常规更新的修正量；连续跳日时每日调用一次。
// 幂等：同一事件同一天已写入 weather_log 则直接跳过，读档/重试不会重复扣损。
export function settleWeather(absDay, farmId) {
  const mods = { waterAdd: 0, fertAdd: 0, lightAdd: 0, setWater: null, pestAdd: 0, growthBlock: false, stageRegressChance: 0, animalHpAdd: 0, animalRecover: 0, lightRecover: 0, plantDamage: 0, plantRecover: 0, weatherBad: false }
  const logs = []
  const ev = q1('SELECT * FROM weather_events WHERE farm_id=? AND done=0 ORDER BY abs_day LIMIT 1', farmId)
  if (!ev) {
    // 无事件：晴好恢复日
    mods.animalRecover = 8
    mods.lightRecover = 10
    mods.plantRecover = 5
    return { mods, logs, type: 'sunny', severity: 0 }
  }
  if (q1('SELECT id FROM weather_log WHERE event_id=? AND abs_day=?', ev.id, absDay)) {
    return { mods, logs, type: ev.type, severity: ev.severity }
  }

  const def = TYPES[ev.type] || TYPES.sunny
  if (!def.bad) {
    if (ev.type === 'rain') { mods.setWater = 100; mods.lightAdd = -10 }
    mods.animalRecover = 8
    mods.lightRecover = 10
    mods.plantRecover = 4
    finishDay(ev, absDay, logs, `${def.icon} ${def.name}：风调雨顺，作物与动物状态恢复`, farmId)
    return { mods, logs, type: ev.type, severity: ev.severity }
  }

  // 恶劣天气：按天结算防护消耗（金币+物资），防护等级决定损失系数
  const up = upkeepOf(ev)
  let tier = 0 // 0 无防护 / 1 半防护 / 2 全防护
  if (ev.protect_gold >= up.gold && ev.protect_mat >= up.mat) tier = 2
  else if (ev.protect_gold >= up.gold) tier = 1
  if (tier >= 1) run('UPDATE weather_events SET protect_gold=protect_gold-? WHERE id=?', up.gold, ev.id)
  if (tier === 2) run('UPDATE weather_events SET protect_mat=protect_mat-? WHERE id=?', up.mat, ev.id)
  const factor = tier === 2 ? 0.15 : tier === 1 ? 0.5 : 1
  const e = def.effects || {}
  const sev = ev.severity
  if (e.flood) mods.setWater = 100
  mods.waterAdd -= Math.round((e.water || 0) * sev * factor)
  mods.fertAdd -= Math.round((e.fert || 0) * sev * factor)
  mods.lightAdd -= Math.round((e.light || 0) * sev * factor)
  if ((e.pest || 0) && factor >= 0.5) mods.pestAdd += e.pest
  if (e.growthBlock && factor >= 0.5) mods.growthBlock = true
  mods.stageRegressChance = (e.regress || 0) * factor
  mods.animalHpAdd -= Math.round((e.animal || 0) * sev * factor)
  // 育种试验健康伤害：与动物伤害同源（灾害越强伤害越高），受防护系数折减
  mods.plantDamage = Math.round((e.animal || 0) * sev * factor)
  mods.weatherBad = true

  const tierTxt = ['⚠️无防护', '🛡️半防护', '🛡️全防护'][tier]
  const parts = []
  if (mods.waterAdd) parts.push(`水分${mods.waterAdd}`)
  if (mods.fertAdd) parts.push(`肥力${mods.fertAdd}`)
  if (mods.lightAdd) parts.push(`光照${mods.lightAdd}`)
  if (mods.pestAdd) parts.push(`虫害+${mods.pestAdd}`)
  if (mods.growthBlock) parts.push('作物停止生长')
  if (mods.animalHpAdd) parts.push(`动物健康${mods.animalHpAdd}`)
  finishDay(ev, absDay, logs,
    `${def.icon} ${def.name} 第${ev.settled_days + 1}/${ev.duration}天 · ${tierTxt}（防护消耗🪙${tier >= 1 ? up.gold : 0}+物资×${tier === 2 ? up.mat : 0}）：${parts.join('，') || '影响轻微'}`,
    farmId)
  return { mods, logs, type: ev.type, severity: ev.severity }
}

// 写入当日结算日志并推进事件进度；事件结束时返还剩余防护金币（物资已投入不退）
function finishDay(ev, absDay, logs, msg, farmId) {
  const sd = ev.settled_days + 1
  let finalMsg = msg
  if (sd >= ev.duration) {
    const left = q1('SELECT protect_gold FROM weather_events WHERE id=?', ev.id).protect_gold
    run('UPDATE weather_events SET settled_days=?, done=1 WHERE id=?', sd, ev.id)
    if (left > 0) {
      run('UPDATE player SET gold=gold+? WHERE farm_id=?', left, farmId)
      finalMsg += `；事件结束，返还剩余防护金🪙${left}`
    }
  } else {
    run('UPDATE weather_events SET settled_days=? WHERE id=?', sd, ev.id)
  }
  run('INSERT INTO weather_log (farm_id,event_id,abs_day,msg) VALUES (?,?,?,?)', farmId, ev.id, absDay, finalMsg)
  logs.push(finalMsg)
}
