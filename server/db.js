import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'farm.db'))

// 启用基本约束；联机多端并发写入时短暂等待锁，而不是立刻报 SQLITE_BUSY
db.exec('PRAGMA foreign_keys = ON;')
db.exec('PRAGMA busy_timeout = 5000;')

const q1 = (sql, ...p) => db.prepare(sql).get(...p)

// ===== 联机共营相关表 =====
// farms：一座农场即一个共营存档。id=1 为兼容旧单人存档预置的农场（owner_id 为空表示待认领）。
db.exec(`
CREATE TABLE IF NOT EXISTS farms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  owner_id INTEGER,                    -- 场主 users.id；NULL=旧单人存档尚未认领（任何人可进入）
  version INTEGER NOT NULL DEFAULT 0,  -- 乐观锁版本：每次变更 +1，多端据此检测并发冲突
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- 农场成员：role owner/admin/member；status active/left（退出后保留行，可被重新邀请回归）
CREATE TABLE IF NOT EXISTS farm_members (
  farm_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  joined_at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (farm_id, user_id)
);

-- 邀请码：可限次数、限有效期、限定授予角色
CREATE TABLE IF NOT EXISTS farm_invites (
  code TEXT PRIMARY KEY,
  farm_id INTEGER NOT NULL,
  created_by INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',   -- 加入后授予的角色 member/admin
  uses INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`)

// 兼容旧存档：先确保 id=1 的农场占位行存在（迁移数据全部归属该农场）
db.prepare('INSERT OR IGNORE INTO farms (id,name,owner_id,created_at) VALUES (1,?,?,?)')
  .run('我的农场', null, Date.now())

// 杂交品种自增起点必须在迁移重建表前抬到 1000（UPSERT MAX：旧存档已有更高 id 时不回退）
db.exec("INSERT OR IGNORE INTO sqlite_sequence(name,seq) VALUES('crop_varieties',999)")

// ===== 旧单人存档 → 多农场结构迁移（只执行一次）=====
const metaDone = db.prepare("SELECT value FROM schema_meta WHERE key='coop_v1'").get()
const tableExists = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
// 注意：PRAGMA 必须限定具体表；不带表名时返回的是所有表的列信息，会误判列已存在而跳过迁移
const columnExists = (t, c) => db.prepare('PRAGMA table_info(' + t + ')').all().some((x) => x.name === c)

function recreateTable(name, createSql, copySql) {
  db.exec('ALTER TABLE ' + name + ' RENAME TO _old_' + name)
  db.exec(createSql)
  if (copySql) db.exec(copySql)
  db.exec('DROP TABLE _old_' + name)
}

if (!metaDone) {
  db.exec('BEGIN')
  try {
    // player：原表 CHECK(id=1) 与自增主键不再适用，改为「每农场一行」，主键 farm_id
    if (tableExists('player') && !columnExists('player', 'farm_id')) {
      recreateTable('player', `
        CREATE TABLE player (
          farm_id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          gold INTEGER NOT NULL DEFAULT 100,
          level INTEGER NOT NULL DEFAULT 1,
          exp INTEGER NOT NULL DEFAULT 0,
          season INTEGER NOT NULL DEFAULT 0,
          day INTEGER NOT NULL DEFAULT 1,
          hour INTEGER NOT NULL DEFAULT 8,
          abs_day INTEGER NOT NULL DEFAULT 1
        )`,
        `INSERT INTO player (farm_id,name,gold,level,exp,season,day,hour,abs_day)
         SELECT 1, name, gold, level, exp, season, day, hour, COALESCE(abs_day,1) FROM _old_player`)
    }
    // crops：基础作物每个农场各自一份（id 在农场内从 1 开始）
    if (tableExists('crops') && !columnExists('crops', 'farm_id')) {
      recreateTable('crops', `
        CREATE TABLE crops (
          farm_id INTEGER NOT NULL,
          id INTEGER NOT NULL,
          name TEXT NOT NULL,
          days INTEGER NOT NULL,
          season INTEGER NOT NULL,
          price INTEGER NOT NULL,
          seedPrice INTEGER NOT NULL,
          sprite TEXT NOT NULL,
          PRIMARY KEY (farm_id, id)
        )`,
        `INSERT INTO crops (farm_id,id,name,days,season,price,seedPrice,sprite)
         SELECT 1,id,name,days,season,price,seedPrice,sprite FROM _old_crops`)
    }
    // inventory：物品 id 在农场内唯一
    if (tableExists('inventory') && !columnExists('inventory', 'farm_id')) {
      recreateTable('inventory', `
        CREATE TABLE inventory (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          farm_id INTEGER NOT NULL,
          item_id TEXT NOT NULL,
          name TEXT NOT NULL,
          cat TEXT NOT NULL,
          qty INTEGER NOT NULL,
          UNIQUE(farm_id, item_id)
        )`,
        `INSERT INTO inventory (farm_id,item_id,name,cat,qty)
         SELECT 1,item_id,name,cat,qty FROM _old_inventory`)
    }
    // buildings：固定建筑每个农场各自一份
    if (tableExists('buildings') && !columnExists('buildings', 'farm_id')) {
      recreateTable('buildings', `
        CREATE TABLE buildings (
          farm_id INTEGER NOT NULL,
          id INTEGER NOT NULL,
          name TEXT NOT NULL,
          level INTEGER NOT NULL DEFAULT 1,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          desc TEXT NOT NULL,
          PRIMARY KEY (farm_id, id)
        )`,
        `INSERT INTO buildings (farm_id,id,name,level,x,y,desc)
         SELECT 1,id,name,level,x,y,desc FROM _old_buildings`)
    }
    // irrigation：坐标在农场内唯一（旧表 UNIQUE(x,y) 与新约束不同，必须重建）
    if (tableExists('irrigation') && !columnExists('irrigation', 'farm_id')) {
      recreateTable('irrigation', `
        CREATE TABLE irrigation (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          farm_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          x INTEGER NOT NULL,
          y INTEGER NOT NULL,
          active INTEGER NOT NULL DEFAULT 1,
          water INTEGER NOT NULL DEFAULT 0,
          UNIQUE(farm_id, x, y)
        )`,
        `INSERT INTO irrigation (farm_id,kind,x,y,active,water)
         SELECT 1,kind,x,y,active,water FROM _old_irrigation`)
    }
    // irrigation_report：每日报告在农场内按绝对天唯一（旧表 UNIQUE(abs_day) 需重建）
    if (tableExists('irrigation_report') && !columnExists('irrigation_report', 'farm_id')) {
      recreateTable('irrigation_report', `
        CREATE TABLE irrigation_report (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          farm_id INTEGER NOT NULL,
          abs_day INTEGER NOT NULL,
          detail TEXT NOT NULL,
          UNIQUE(farm_id, abs_day)
        )`,
        `INSERT INTO irrigation_report (farm_id,abs_day,detail)
         SELECT 1,abs_day,detail FROM _old_irrigation_report`)
    }
    // crop_varieties：品种 id 全局自增（从 1000 起），但 name/sig 唯一约束改为农场内；
    // 显式保留旧品种 id，避免迁移后自增主键从 1 开始与基础作物 id 冲突
    if (tableExists('crop_varieties') && !columnExists('crop_varieties', 'farm_id')) {
      recreateTable('crop_varieties', `
        CREATE TABLE crop_varieties (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          farm_id INTEGER NOT NULL,
          base_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          sprite TEXT NOT NULL,
          season INTEGER NOT NULL,
          days INTEGER NOT NULL,
          price INTEGER NOT NULL,
          seed_price INTEGER NOT NULL,
          traits TEXT NOT NULL DEFAULT '[]',
          sig TEXT NOT NULL,
          parent_a TEXT NOT NULL,
          parent_b TEXT NOT NULL,
          gen INTEGER NOT NULL DEFAULT 1,
          created_abs INTEGER NOT NULL,
          UNIQUE(farm_id, name),
          UNIQUE(farm_id, sig)
        )`,
        `INSERT INTO crop_varieties
           (id,farm_id,base_id,name,sprite,season,days,price,seed_price,traits,sig,parent_a,parent_b,gen,created_abs)
         SELECT id,1,base_id,name,sprite,season,days,price,seed_price,traits,sig,parent_a,parent_b,gen,created_abs
         FROM _old_crop_varieties`)
      // 显式 id 插入会自动抬升 sqlite_sequence，无需额外处理
    }
    db.prepare("INSERT INTO schema_meta (key,value) VALUES ('coop_v1','1')").run()
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 事务可能已结束 */ }
    throw e
  }
}

// 其余仅追加 farm_id 列即可的表（id 全局自增，不存在跨农场约束冲突）
for (const t of ['plots', 'animals', 'weather_events', 'weather_log', 'production_jobs', 'breeding_trials']) {
  if (tableExists(t) && !columnExists(t, 'farm_id')) {
    db.exec('ALTER TABLE ' + t + ' ADD COLUMN farm_id INTEGER NOT NULL DEFAULT 1')
  }
}

// 协作排产扩展：工单补 seq（队列顺序）与 created_by/created_name（排产人）
// 旧工单按 id 顺序补 seq，即历史排产顺序不变
if (tableExists('production_jobs')) {
  if (!columnExists('production_jobs', 'seq')) {
    db.exec('ALTER TABLE production_jobs ADD COLUMN seq INTEGER NOT NULL DEFAULT 0')
  }
  if (!columnExists('production_jobs', 'created_by')) {
    db.exec('ALTER TABLE production_jobs ADD COLUMN created_by INTEGER')
  }
  if (!columnExists('production_jobs', 'created_name')) {
    db.exec('ALTER TABLE production_jobs ADD COLUMN created_name TEXT')
  }
  const needBackfill = q1('SELECT COUNT(*) c FROM production_jobs WHERE seq=0').c
  if (needBackfill) {
    db.exec('UPDATE production_jobs SET seq=id WHERE seq=0')
  }
}

// 全新存档：建立完整多农场版表结构
db.exec(`
CREATE TABLE IF NOT EXISTS player (
  farm_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  gold INTEGER NOT NULL DEFAULT 100,
  level INTEGER NOT NULL DEFAULT 1,
  exp INTEGER NOT NULL DEFAULT 0,
  season INTEGER NOT NULL DEFAULT 0,      -- 0春 1夏 2秋 3冬
  day INTEGER NOT NULL DEFAULT 1,
  hour INTEGER NOT NULL DEFAULT 8,
  abs_day INTEGER NOT NULL DEFAULT 1      -- 绝对天数（天气/灌溉/加工结算对齐用）
);

CREATE TABLE IF NOT EXISTS plots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL DEFAULT 1,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  crop_id INTEGER DEFAULT NULL,           -- 关联 crops.id（基础作物 <1000，杂交品种 >=1000）
  stage INTEGER NOT NULL DEFAULT -1,      -- -1 空地 0播种 1..n-1生长 n成熟
  water INTEGER NOT NULL DEFAULT 100,
  fert INTEGER NOT NULL DEFAULT 100,
  light INTEGER NOT NULL DEFAULT 100,
  pest INTEGER NOT NULL DEFAULT 0,        -- 0无 越高越差
  planted_day INTEGER,
  planted_season INTEGER,
  irr_priority INTEGER NOT NULL DEFAULT 1,  -- 灌溉保水优先级 0低 1中 2高
  irr_target INTEGER NOT NULL DEFAULT 100   -- 目标水分（0 表示不自动浇水）
);

CREATE TABLE IF NOT EXISTS crops (
  farm_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  days INTEGER NOT NULL,
  season INTEGER NOT NULL,               -- 适宜季节
  price INTEGER NOT NULL,
  seedPrice INTEGER NOT NULL,
  sprite TEXT NOT NULL,
  PRIMARY KEY (farm_id, id)
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cat TEXT NOT NULL,                     -- seed/crop/product/material/animal/other
  qty INTEGER NOT NULL,
  UNIQUE(farm_id, item_id)
);

CREATE TABLE IF NOT EXISTS buildings (
  farm_id INTEGER NOT NULL,
  id INTEGER NOT NULL,
  name TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 1,
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  desc TEXT NOT NULL,
  PRIMARY KEY (farm_id, id)
);

CREATE TABLE IF NOT EXISTS animals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  species TEXT NOT NULL,                 -- chicken/cow/sheep
  feed INTEGER NOT NULL DEFAULT 100,
  health INTEGER NOT NULL DEFAULT 100,
  ready INTEGER NOT NULL DEFAULT 0,      -- 可收集产物 0/1
  x INTEGER NOT NULL,
  y INTEGER NOT NULL
);

-- 天气事件：按季节生成并持久化；防护投入与结算进度都落库
CREATE TABLE IF NOT EXISTS weather_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL DEFAULT 1,
  season INTEGER NOT NULL,
  day INTEGER NOT NULL,                  -- 季节内第几天（事件开始日）
  abs_day INTEGER NOT NULL,              -- 绝对天数（全局递增，结算对齐用）
  type TEXT NOT NULL,                    -- sunny/rain/drought/storm/frost/heatwave/blizzard/freeze/wind
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 1,   -- 持续天数
  severity INTEGER NOT NULL DEFAULT 0,   -- 0 无害 / 1~3 灾害等级
  protect_gold INTEGER NOT NULL DEFAULT 0,  -- 已投入防护金币储备
  protect_mat INTEGER NOT NULL DEFAULT 0,   -- 已投入防护物资储备
  settled_days INTEGER NOT NULL DEFAULT 0,  -- 已结算天数（防重复扣损）
  done INTEGER NOT NULL DEFAULT 0
);

-- 天气逐日结算日志：UNIQUE(event_id, abs_day) 保证同一天只结算一次
CREATE TABLE IF NOT EXISTS weather_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL DEFAULT 1,
  event_id INTEGER NOT NULL,
  abs_day INTEGER NOT NULL,
  msg TEXT NOT NULL,
  UNIQUE(event_id, abs_day)
);

-- 灌溉设施：蓄水池(reservoir)储水，水渠(canal)连接蓄水池与地块；
-- 停用(active=0)即断流，重新启用自动恢复供水；拆除直接删行
CREATE TABLE IF NOT EXISTS irrigation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                 -- reservoir/canal
  x INTEGER NOT NULL,
  y INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  water INTEGER NOT NULL DEFAULT 0,   -- 蓄水池当前水量（水渠恒为 0）
  UNIQUE(farm_id, x, y)
);

-- 灌溉每日分配结果：按农场+绝对天唯一（同日重算覆盖），缺水时前端展示逐地块明细
CREATE TABLE IF NOT EXISTS irrigation_report (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL,
  abs_day INTEGER NOT NULL UNIQUE,
  detail TEXT NOT NULL,
  UNIQUE(farm_id, abs_day)
);

-- 加工生产工单：批量排产，按游戏天串行推进；取消时记录取消绝对日用于退料与队列重排
CREATE TABLE IF NOT EXISTS production_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL DEFAULT 1,
  recipe_id TEXT NOT NULL,              -- 配方 id（见 server/production.js RECIPES）
  recipe_name TEXT NOT NULL,
  result_id TEXT NOT NULL,
  result_name TEXT NOT NULL,
  result_cat TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  from_cat TEXT NOT NULL,
  consume INTEGER NOT NULL,             -- 每批消耗原料数
  gain INTEGER NOT NULL,                -- 每批产出成品数
  days INTEGER NOT NULL,                -- 每批耗时（游戏天）
  qty INTEGER NOT NULL,                 -- 批次数
  finished INTEGER NOT NULL DEFAULT 0,  -- 已完工批次数（跨天结算时落库）
  enqueue_abs INTEGER NOT NULL,         -- 排产时的绝对天
  cancel_abs INTEGER DEFAULT NULL,      -- 取消时的绝对天（NULL 未取消）
  inputs TEXT DEFAULT NULL,             -- 按批次登记的实际投料明细（JSON，取消时原样退回）
  seq INTEGER NOT NULL DEFAULT 0,       -- 队列顺序（多人协作可重排；历史顺序不再等同于 id）
  created_by INTEGER,                   -- 排产人 users.id（NULL=升级前旧工单，任何成员可管理）
  created_name TEXT,                    -- 排产人昵称快照（成员改名/退出后仍可展示）
  status TEXT NOT NULL DEFAULT 'running' -- running/done/canceled/collected
);

-- ===== 杂交育种 =====
-- 杂交新品种（遗传性状作物）：id 全局从 1000 起，跨农场唯一；库存物品 seed-v<id>/crop-v<id> 按农场隔离
CREATE TABLE IF NOT EXISTS crop_varieties (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL,
  base_id INTEGER NOT NULL,             -- 本源基础作物 crops.id
  name TEXT NOT NULL,
  sprite TEXT NOT NULL,
  season INTEGER NOT NULL,              -- 适宜季节（随本源）
  days INTEGER NOT NULL,                -- 成熟期（性状已折算）
  price INTEGER NOT NULL,               -- 售价（性状已折算）
  seed_price INTEGER NOT NULL,
  traits TEXT NOT NULL DEFAULT '[]',    -- 遗传性状 key 数组（JSON）
  sig TEXT NOT NULL,                    -- 农场内：本源作物 + 排序后性状
  parent_a TEXT NOT NULL,               -- 父本引用：base:<id> / var:<id>
  parent_b TEXT NOT NULL,               -- 母本引用
  gen INTEGER NOT NULL DEFAULT 1,       -- 谱系代数（基础作物为 0）
  created_abs INTEGER NOT NULL,
  UNIQUE(farm_id, name),
  UNIQUE(farm_id, sig)
);

-- 育种试验：投入两批作物，随游戏天推进，受养护与天气影响，成熟产出带遗传性状的种子
CREATE TABLE IF NOT EXISTS breeding_trials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  farm_id INTEGER NOT NULL DEFAULT 1,
  parent_a TEXT NOT NULL,
  parent_b TEXT NOT NULL,
  parent_a_name TEXT NOT NULL,
  parent_a_icon TEXT NOT NULL,
  parent_a_traits TEXT NOT NULL DEFAULT '[]',
  parent_b_name TEXT NOT NULL,
  parent_b_icon TEXT NOT NULL,
  parent_b_traits TEXT NOT NULL DEFAULT '[]',
  base_id INTEGER NOT NULL,             -- 子代本源作物（跨种杂交时随机取亲本之一）
  traits_json TEXT NOT NULL DEFAULT '[]', -- 授粉时即确定的子代性状
  status TEXT NOT NULL DEFAULT 'running', -- running/done/failed/canceled
  progress INTEGER NOT NULL DEFAULT 0,  -- 已发育天数（达标即成熟）
  days_total INTEGER NOT NULL DEFAULT 4,
  water INTEGER NOT NULL DEFAULT 75,    -- 试验田水分（浇水养护）
  fert INTEGER NOT NULL DEFAULT 75,     -- 肥力（施肥养护）
  health INTEGER NOT NULL DEFAULT 100,  -- 健康度（恶劣天气下降，照料恢复；归零试验失败）
  care INTEGER NOT NULL DEFAULT 0,      -- 养护累计分 0~100（决定产出种子数）
  care_count INTEGER NOT NULL DEFAULT 0,
  blocked_days INTEGER NOT NULL DEFAULT 0, -- 受阻天数（条件不良/灾害停长）
  result_variety_id INTEGER,
  result_seeds INTEGER NOT NULL DEFAULT 0,
  start_abs INTEGER NOT NULL,
  finish_abs INTEGER
);

CREATE INDEX IF NOT EXISTS idx_plots_farm ON plots(farm_id);
CREATE INDEX IF NOT EXISTS idx_animals_farm ON animals(farm_id);
CREATE INDEX IF NOT EXISTS idx_wevents_farm ON weather_events(farm_id);
CREATE INDEX IF NOT EXISTS idx_wlog_farm ON weather_log(farm_id);
CREATE INDEX IF NOT EXISTS idx_jobs_farm ON production_jobs(farm_id);
CREATE INDEX IF NOT EXISTS idx_trials_farm ON breeding_trials(farm_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON farm_members(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_farm ON farm_invites(farm_id);
`)

// 杂交品种 id 从 1000 起，避免与基础作物 crops.id（1..n）冲突；
// 迁移后的旧存档已保留原品种 id，序列永不回退
db.exec("INSERT OR IGNORE INTO sqlite_sequence(name,seq) VALUES('crop_varieties',999)")

// ===== 权限矩阵：共营农场的角色权限隔离 =====
// member（成员）：日常种植/养护/交易/生产/育种养护
// admin（管理员）：推进时间与灾害结算、防灾设施建造拆除、发起杂交试验、邀请管理
// owner（场主）：成员角色调整、转让、解散、建筑升级（并继承以上全部）
export const ROLE_PERMS = {
  member: new Set([
    'plant', 'water', 'fertilize', 'clean', 'harvest',
    'protect', 'buymat', 'buyseed', 'sellcrop',
    'adopt', 'feed', 'collect',
    'enqueue', 'cancelJob', 'collectJob', 'reorderJob',
    'irrigToggle', 'irrigPriority', 'irrigTarget',
    'careTrial', 'cancelTrial'
  ]),
  admin: new Set([
    'nextday', 'irrigBuild', 'irrigDemolish', 'breedStart',
    'inviteCreate', 'inviteList', 'inviteRevoke'
  ]),
  owner: new Set(['upgrade', 'memberRole', 'transfer', 'disband'])
}
export function roleCan(role, perm) {
  if (role === 'owner') return true
  if (role === 'admin') return ROLE_PERMS.member.has(perm) || ROLE_PERMS.admin.has(perm)
  return !!role && ROLE_PERMS.member.has(perm)
}
