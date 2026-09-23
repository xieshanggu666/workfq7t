import { db } from './db.js'

const q = (sql, ...p) => db.prepare(sql).all(...p)
const run = (sql, ...p) => db.prepare(sql).run(...p)

// ===== 基础作物 / 初始建筑（每个农场各一份）=====
const CROPS = [
  ['萝卜', 3, 0, 8, 2, '🥕'],
  ['番茄', 5, 0, 15, 4, '🍅'],
  ['玉米', 6, 1, 20, 5, '🌽'],
  ['南瓜', 7, 2, 30, 8, '🎃'],
  ['小麦', 5, 0, 12, 3, '🌾'],
  ['白菜', 4, 2, 10, 3, '🥬']
]
const BUILDINGS = [
  ['农舍', 1, 0, 7, '你的家，升级可解锁新功能'],
  ['加工坊', 1, 7, 0, '将作物加工为制品出售'],
  ['畜棚', 1, 8, 7, '养殖动物，产出蛋奶毛'],
  ['市场', 1, 7, 6, '出售作物与制品'],
  ['育种棚', 1, 10, 7, '杂交育种：投入两批作物培育带遗传性状的新品种']
]

// 初始化一座新农场的存档数据（玩家、6x6 耕地、基础作物、初始背包、建筑）
export function seedFarm(farmId, farmName) {
  run('INSERT INTO player (farm_id,name,gold) VALUES (?,?,100)', farmId, farmName)

  const cropIns = db.prepare('INSERT INTO crops (farm_id,id,name,days,season,price,seedPrice,sprite) VALUES (?,?,?,?,?,?,?,?)')
  CROPS.forEach((c, i) => cropIns.run(farmId, i + 1, ...c))

  const plotIns = db.prepare('INSERT INTO plots (farm_id,x,y) VALUES (?,?,?)')
  for (let x = 0; x < 6; x++) for (let y = 0; y < 6; y++) plotIns.run(farmId, x, y)

  const invIns = db.prepare('INSERT INTO inventory (farm_id,item_id,name,cat,qty) VALUES (?,?,?,?,?)')
  invIns.run(farmId, 'seed-1', '萝卜种子', 'seed', 10)
  invIns.run(farmId, 'gold_seed_5', '小麦种子', 'seed', 5)
  invIns.run(farmId, 'disaster-kit', '防灾物资', 'material', 3)

  const bIns = db.prepare('INSERT INTO buildings (farm_id,id,name,level,x,y,desc) VALUES (?,?,?,?,?,?,?)')
  BUILDINGS.forEach((b, i) => bIns.run(farmId, i + 1, ...b))
}

// 首次启动旧单人存档：farm 1 无玩家行时补全套初始数据（与旧版 seed() 行为一致）
export function ensureLegacySeed() {
  if (q('SELECT farm_id FROM player WHERE farm_id=1').length) return
  seedFarm(1, '我的农场')
}
