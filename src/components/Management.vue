<template>
  <div class="tabs">
    <button v-for="t in tabs" :key="t.key" :class="{active:tab===t.key}" @click="tab=t.key">
      {{ t.label }}
      <span v-if="t.key==='process' && collectableJobs.length" class="badge">{{ collectableJobs.length }}</span>
      <span v-if="t.key==='breed' && runningTrials" class="badge breed-badge">{{ runningTrials }}</span>
    </button>
  </div>

  <!-- 育种棚 -->
  <BreedingPanel v-if="tab==='breed'" />

  <!-- 市场 -->
  <div v-if="tab==='market'" class="page">
    <div class="pcol card">
      <h4>🌾 种子商店</h4>
      <div class="row" v-for="c in store.crops" :key="c.id">
        <span class="i">{{ c.sprite }}</span>
        <div class="m-info">
          <b>{{ c.name }}</b>
          <span class="tag season s{{c.season}}">宜{{['春','夏','秋','冬'][c.season]}}</span>
          <span class="tag">{{ c.days }}天成熟</span>
        </div>
        <span class="price seed">🪙{{ c.seedPrice }}</span>
        <button class="mini" @click="store.buySeed(c.id,1)">买</button>
        <button class="mini" @click="store.buySeed(c.id,5)">买×5</button>
      </div>
    </div>
    <div class="pcol card">
      <h4>💰 出售作物</h4>
      <div v-if="!sellable.length" class="none">暂无库存，请先收获作物</div>
      <div class="row" v-for="s in sellable" :key="s.item_id">
        <span class="i">{{ s.icon }}</span>
        <div class="m-info"><b>{{ s.name }}<span v-if="s.isVariety" class="tag gen">🧬 品种</span></b><span class="tag">×{{ s.qty }}</span></div>
        <span class="price">🪙{{ s.unit }} /个</span>
        <button class="mini green" @click="store.sellCrop(s.cropId,1)">卖1</button>
        <button class="mini green" @click="store.sellCrop(s.cropId,5)">卖5</button>
      </div>
    </div>
    <div class="pcol card">
      <h4>🧰 物资商店</h4>
      <div class="row">
        <span class="i">🧱</span>
        <div class="m-info">
          <b>防灾物资</b>
          <span class="tag">恶劣天气时投入防护</span>
          <span class="tag">持有 ×{{ matCount }}</span>
        </div>
        <span class="price seed">🪙12</span>
        <button class="mini" @click="store.buyMat(1)">买</button>
        <button class="mini" @click="store.buyMat(5)">买×5</button>
      </div>
    </div>
  </div>

  <!-- 加工坊 -->
  <div v-if="tab==='process'" class="page">
    <!-- 配方 / 批量排产 -->
    <div class="pcol card">
      <h4>⚙️ 加工坊 <span class="lvl">Lv.{{ mill.level }}</span></h4>
      <div class="queue-stat">
        排产占用 <b :class="{full: store.queuedBatches >= store.queueCapacity}">{{ store.queuedBatches }}/{{ store.queueCapacity }}</b> 批
        <span class="tag">每批按游戏天加工，跨天自动推进</span>
        <span class="tag">排队工单可上下重排，开工后锁定</span>
      </div>
      <div class="held-sum" v-if="store.productionReserved.length">
        🔒 队列已锁原料：
        <span class="tag held" v-for="it in store.productionReserved" :key="it.itemId"
              :class="{gen:it.itemId.startsWith('crop-v')}">
          {{ itemIcon(it.itemId) }} {{ it.name }} ×{{ it.qty }}
        </span>
        <span class="tag tip">取消未开工批次即原样退回（含🧬品种）</span>
      </div>
      <div class="row recipe" v-for="r in store.recipes" :key="r.id">
        <span class="i">{{ r.icon }}</span>
        <div class="m-info">
          <b>{{ r.name }}
            <span v-if="mill.level < r.needLv" class="tag lock">🔒 Lv.{{ r.needLv }}</span>
          </b>
          <span class="tag">{{ r.fromIcon }} {{ r.fromName }} ×{{ r.consume }}/批</span>
          <span class="tag">→ {{ r.name }} ×{{ r.gain }}</span>
          <span class="tag">⏱ {{ r.days }} 天/批</span>
          <span class="tag" :class="{mixed:r.baseCrop}">
            可用 ×{{ recipeStock(r) }}{{ recipeHeld(r) ? `（🔒${recipeHeld(r)}）` : '' }}{{ r.baseCrop ? '（含🧬品种）' : '' }}
          </span>
        </div>
        <div class="proc-ctl">
          <button class="mini" :disabled="!canMake(r,1)" @click="doEnqueue(r,1)">排产×1</button>
          <button class="mini" :disabled="!canMake(r,5)" @click="doEnqueue(r,5)">排产×5</button>
        </div>
      </div>
      <button class="wide" :disabled="!store.can('upgrade')" :title="store.can('upgrade') ? '' : '仅场主可升级建筑'"
              @click="store.upgradeBuilding(mill.id)">🔧 升级加工坊（🪙{{ mill.level*40 }}）→ 扩容队列、解锁更多配方</button>
    </div>

    <!-- 生产队列 -->
    <div class="pcol card">
      <h4>🏭 生产队列
        <button v-if="collectableJobs.length" class="mini green collect-all" @click="store.collectProduction()">
          一键入库（{{ collectableBatches }}）
        </button>
      </h4>
      <div v-if="!activeJobs.length" class="none">队列为空，去左侧选择配方批量排产吧</div>
      <div v-for="(j, i) in activeJobs" :key="j.id" class="job" :class="j.computedStatus">
        <div class="reorder-ctl" v-if="j.status==='running' && isWaiting(j)">
          <button class="mini arrow" :disabled="!canMove(i, -1)" title="提前一位" @click="store.reorderProduction(j.id,-1)">▲</button>
          <button class="mini arrow" :disabled="!canMove(i, +1)" title="延后一位" @click="store.reorderProduction(j.id,+1)">▼</button>
        </div>
        <div class="reorder-ctl placeholder" v-else></div>
        <span class="i">{{ recipeIcon(j.recipe_id) }}</span>
        <div class="m-info">
          <b>
            {{ j.recipe_name }} ×{{ j.status==='canceled' ? j.gain*j.doneBatches : j.gain*j.qty }}
            <span class="job-state" :class="j.computedStatus">{{ stateLabel(j) }}</span>
            <span class="creator" v-if="j.creator">
              👤{{ j.creator.name }}
              <i class="live-dot" :class="{on: store.onlineUserIds.has(j.creator.id)}"
                 :title="store.onlineUserIds.has(j.creator.id) ? '排产人在线' : '排产人离线'"></i>
            </span>
          </b>
          <span class="tag">批次 {{ j.doneBatches }}/{{ j.qty }}</span>
          <span class="tag" v-if="j.computedStatus==='running'">⏳ 约剩 {{ j.remainDays }} 天</span>
          <span class="tag" v-if="j.status==='canceled' && j.refundedBatches>0">已退 {{ j.refundedBatches }} 批原料</span>
          <span class="tag held-line" v-if="j.status==='running' && j.occupiedItems && j.occupiedItems.length">
            🔒投料
            <i v-for="it in j.occupiedItems" :key="it.itemId" :class="{gen:it.itemId.startsWith('crop-v')}">
              {{ itemIcon(it.itemId) }}{{ it.name }}×{{ it.qty }}
            </i>
          </span>
          <span class="tag held-line" v-else-if="j.status==='canceled' && j.refundedBatches>0">
            ↩退回
            <i v-for="it in refundedOf(j)" :key="it.itemId" :class="{gen:it.itemId.startsWith('crop-v')}">
              {{ itemIcon(it.itemId) }}{{ it.name }}×{{ it.qty }}
            </i>
          </span>
          <div class="job-bar"><i :style="{width:(j.doneBatches/j.qty*100)+'%'}"></i></div>
        </div>
        <button v-if="j.status==='running'" class="mini" :disabled="!store.canManageJob(j)"
                :title="store.canManageJob(j) ? '取消未开工批次并退回原料' : '只能取消自己排产的工单'"
                @click="store.cancelProduction(j.id)">取消退料</button>
        <button v-if="(j.computedStatus==='done' || j.status==='canceled') && j.doneBatches>0"
                class="mini green" @click="store.collectProduction(j.id)">
          入库 ×{{ j.gain*j.doneBatches }}
        </button>
      </div>
    </div>
  </div>

  <!-- 畜棚 -->
  <div v-if="tab==='barn'" class="page">
    <div class="pcol card">
      <h4>🐖 畜棚 <span class="lvl">Lv.{{ barn.level }}</span></h4>
      <div class="adopt">
        <button class="ad" @click="store.buyAnimal('chicken')">🐔 母鸡 <span>🪙30</span></button>
        <button class="ad" @click="store.buyAnimal('sheep')">🐑 绵羊 <span>🪙60</span></button>
        <button class="ad" @click="store.buyAnimal('cow')">🐄 奶牛 <span>🪙80</span></button>
      </div>
      <div class="animal-list">
        <div v-if="!store.animals.length" class="none">还没有动物，请领养</div>
        <div v-for="a in store.animals" :key="a.id" class="animal">
          <span class="a-icon">{{ {chicken:'🐔',sheep:'🐑',cow:'🐄'}[a.species] }}</span>
          <div class="m-info">
            <b>{{ a.name }}</b>
            <div class="hp">
              <div class="bar"><i :style="{width:a.feed+'%',background:a.feed<40?'#ef5350':'#4caf50'}"></i></div>
              <span class="tiny">食{{ Math.round(a.feed) }}</span>
            </div>
            <div class="hp"><div class="bar"><i :style="{width:a.health+'%',background:healthColor}"></i></div><span class="tiny">健{{ Math.round(a.health) }}</span></div>
          </div>
          <span class="ready" v-if="a.ready">可收集</span>
          <button class="mini" @click="store.feedAnimal(a.id)">🥣 喂食</button>
          <button class="mini green" :disabled="!a.ready" @click="store.collectAnimal(a.id)">🧺 收集</button>
        </div>
      </div>
      <button class="wide" :disabled="!store.can('upgrade')" :title="store.can('upgrade') ? '' : '仅场主可升级建筑'"
              @click="store.upgradeBuilding(barn.id)">🔧 升级畜棚（🪙{{ barn.level*40 }}）</button>
    </div>
  </div>

  <!-- 背包 -->
  <div v-if="tab==='bag'" class="page">
    <div class="pcol card">
      <h4>🎒 我的背包
        <span class="tag tip" v-if="store.productionReserved.length">作物类为扣除工单投料后的空闲可用量，🔒锁定见加工坊</span>
      </h4>
      <div v-if="!store.inventory.length" class="none">背包空空如也</div>
      <div class="grid">
        <div v-for="it in store.inventory" :key="it.item_id" class="bag-item">
          <span class="b-icon">{{ iconOf(it) }}</span>
          <span class="b-name">{{ it.name }}</span>
          <span class="b-qty">×{{ it.qty }}</span>
          <span class="b-cat">{{ catName(it.cat) }}</span>
        </div>
      </div>
    </div>
  </div>

  <!-- 建筑 -->
  <div v-if="tab==='build'" class="page">
    <div class="pcol card">
      <h4>🏠 建筑一览</h4>
      <div class="row" v-for="b in store.buildings" :key="b.id">
        <span class="i">🏠</span>
        <div class="m-info"><b>{{ b.name }}</b><span class="tag">Lv.{{ b.level }}</span><span class="desc">{{ b.desc }}</span></div>
        <button class="mini" :disabled="!store.can('upgrade')"
                :title="store.can('upgrade') ? '' : '仅场主可升级建筑'"
                @click="store.upgradeBuilding(b.id)">升级</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useGameStore } from '@/store/game'
import BreedingPanel from '@/components/BreedingPanel.vue'
const store = useGameStore()
const tab = ref('market')
const healthColor = '#4caf50'

const tabs = [
  { key: 'market', label: '🏪 市场' },
  { key: 'process', label: '⚙️ 加工坊' },
  { key: 'breed', label: '🧬 育种' },
  { key: 'barn', label: '🐖 畜棚' },
  { key: 'bag', label: '🎒 背包' },
  { key: 'build', label: '🏠 建筑' }
]

// 库存作物 → 展示信息（兼容杂交品种 crop-v<id>）
function cropOfItem(itemId) {
  if (itemId.startsWith('crop-v')) {
    const v = store.varieties.find((x) => x.id === Number(itemId.slice(6)))
    return v ? {
      id: v.id, name: v.name, price: v.price, sprite: v.sprite, isVariety: true
    } : null
  }
  const c = store.crops.find((x) => x.id === Number(itemId.split('-')[1]))
  return c ? { id: c.id, name: c.name, price: c.price, sprite: c.sprite, isVariety: false } : null
}
const sellable = computed(() =>
  store.inventory
    .filter((it) => it.cat === 'crop')
    .map((it) => {
      const c = cropOfItem(it.item_id) || { id: 0, price: 1, sprite: '🧺', name: it.name }
      return { ...it, icon: c.sprite, unit: c.price, cropId: c.id, isVariety: c.isVariety }
    })
)
function catName(c) { return { seed: '种子', crop: '作物', product: '制品', material: '材料' }[c] || c }
function iconOf(it) {
  if (it.cat === 'crop') return cropOfItem(it.item_id)?.sprite || '🧺'
  if (it.cat === 'seed') {
    if (it.item_id.startsWith('seed-v')) return cropOfItem('crop-' + it.item_id.slice(5))?.sprite || '🧬'
    return '🌱'
  }
  if (it.cat === 'product') { return { 'p-chicken': '🥚', 'p-cow': '🥛', 'p-sheep': '🧶' }[it.item_id] || '📦' }
  if (it.item_id === 'disaster-kit') return '🧱'
  return { flour: '🍞', juice: '🧃', cheese: '🧀', bread: '🥖', wool: '🧵', popcorn: '🍿', pickle: '🥬' }[it.item_id] || '📦'
}
const matCount = computed(() =>
  store.inventory.filter((it) => it.cat === 'material').reduce((s, it) => s + it.qty, 0)
)
const mill = computed(() => store.buildings.find((b) => b.name === '加工坊'))
const barn = computed(() => store.buildings.find((b) => b.name === '畜棚'))

// ===== 生产队列 =====
// 配方原料库存：有 baseCrop 时合并本源基础作物与同本源杂交品种（新品种贯通加工）
function stockOf(itemId) {
  return store.inventory.find((it) => it.item_id === itemId)?.qty || 0
}
function recipeStock(r) {
  if (!r.baseCrop) return stockOf(r.from)
  let total = stockOf('crop-' + r.baseCrop)
  for (const v of store.varieties.filter((x) => x.base_id === r.baseCrop)) {
    total += stockOf('crop-v' + v.id)
  }
  return total
}
// 某配方原料当前被在制工单锁定的数量（基础作物 + 同本源品种合并）
function recipeHeld(r) {
  let held = 0
  if (!r.baseCrop) return heldOf(r.from)
  held += heldOf('crop-' + r.baseCrop)
  for (const v of store.varieties.filter((x) => x.base_id === r.baseCrop)) {
    held += heldOf('crop-v' + v.id)
  }
  return held
}
function heldOf(itemId) {
  return store.productionReserved.find((it) => it.itemId === itemId)?.qty || 0
}
// 库存物品图标（与背包一致；含杂交品种作物）
function itemIcon(itemId) {
  if (itemId.startsWith('crop-v') || itemId.startsWith('seed-v')) {
    const id = Number(itemId.slice(6))
    return store.varieties.find((x) => x.id === id)?.sprite || '🧬'
  }
  if (itemId.startsWith('crop-')) {
    return store.crops.find((x) => x.id === Number(itemId.slice(5)))?.sprite || '🧺'
  }
  return {
    flour: '🍞', juice: '🧃', cheese: '🧀', bread: '🥖', wool: '🧵', popcorn: '🍿', pickle: '🥬',
    'p-chicken': '🥚', 'p-cow': '🥛', 'p-sheep': '🧶', 'disaster-kit': '🧱'
  }[itemId] || '📦'
}
const runningTrials = computed(() => store.breeding?.running || 0)
function recipeIcon(id) {
  return store.recipes.find((r) => r.id === id)?.icon || '🛠️'
}
// 剩余可排队批次（容量 - 在队批次）
const freeSlots = computed(() => Math.max(0, store.queueCapacity - store.queuedBatches))
function canMake(r, n) {
  if (mill.value.level < r.needLv) return false
  if (n > freeSlots.value) return false
  return recipeStock(r) >= r.consume * n
}
async function doEnqueue(r, n) {
  // 原料/空位只够一部分时，自动收缩为可做批次数
  const real = Math.min(n, Math.floor(recipeStock(r) / r.consume), freeSlots.value)
  if (real <= 0) return
  try { await store.enqueueProduction(r.id, real) } catch { /* toast 已提示 */ }
}
// 未领走的工单（完工未入库 / 加工中 / 已取消待入库）
const activeJobs = computed(() => store.productionJobs)
// 仍在排队等待（首批未开工）的 running 工单：这些参与重排
function isWaiting(j) {
  return j.status === 'running' && (j.start > (store.player?.abs_day ?? 0))
}
// 仅能在「连续等待工单」范围内相邻交换：目标位也必须是等待工单
function canMove(index, dir) {
  const target = activeJobs.value[index + dir]
  return !!target && isWaiting(target)
}
// 取消单实际已退回的原料（服务端按登记明细返回；旧工单无明细时为空）
function refundedOf(j) {
  return j.refundedItems || []
}
// 可入库 = 全部完工 或 已取消（在制工单须整单完工后才能领）
const collectableJobs = computed(() =>
  store.productionJobs.filter((j) => (j.computedStatus === 'done' || j.status === 'canceled') && j.doneBatches > 0)
)
const collectableBatches = computed(() =>
  collectableJobs.value.reduce((s, j) => s + j.gain * j.doneBatches, 0)
)
function stateLabel(j) {
  if (j.computedStatus === 'done') return '✓ 已完工'
  if (j.status === 'canceled') return '已取消·待入库'
  return j.start > (store.player?.abs_day ?? 0) ? '排队中' : '加工中'
}
</script>

<style scoped>
.tabs { display:flex;gap:6px;margin-bottom:14px; }
.tabs button { background:#13233f;border:1px solid rgba(120,160,220,0.2);color:#aebadd;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:13px;position:relative; }
.tabs button.active { background:linear-gradient(135deg,#1d3f8f,#2962ff);color:#fff;border-color:transparent; }
.badge{position:absolute;top:-6px;right:-6px;background:#e53935;color:#fff;font-size:10px;min-width:16px;height:16px;line-height:16px;border-radius:8px;padding:0 4px;font-weight:700;}
.badge.breed-badge{background:#8e24aa;}
.tag.gen{color:#ce93d8;background:#2a1b3d;}
.tag.mixed{color:#ce93d8;}
.page { display:grid;grid-template-columns:1fr 1fr;gap:16px; }
@media(max-width:760px){ .page{grid-template-columns:1fr;} }
.pcol { display:flex;flex-direction:column;gap:2px; }
.card { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px; }
h4 { margin:0 0 8px;color:#fff;display:flex;gap:8px;align-items:center; }
.lvl { font-size:11px;color:#ffd54f; }
.row { display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.row:last-child{border-bottom:none;}
.i { font-size:22px;width:30px;text-align:center; }
.m-info { flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center; }
.m-info b { color:#e8eefb;font-size:13px;width:100%; }
.tag { font-size:10px;color:#6f84ab;background:#16263f;padding:2px 6px;border-radius:4px; }
.tag.s0,.s.spring{ color:#a5d6a7; } .s1{color:#90caf9;} .s2{color:#ffe082;} .s3{color:#b39ddb;}
.desc { font-size:10px;color:#8ba2c8;width:100%; }
.price { color:#ffc107;font-size:12px;font-weight:600;white-space:nowrap; }
.price.seed { color:#ffb300; }
.mini { background:#2962ff;border:none;color:#fff;border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer; }
.mini.green { background:#43a047; }
.mini:disabled{background:#2a3a5e;color:#6f84ab;cursor:not-allowed;}
.wide { width:100%;margin-top:12px;background:#16263f;border:1px solid rgba(255,213,79,0.3);color:#ffd54f;border-radius:9px;padding:10px;font-size:13px;cursor:pointer; }
.none { color:#5b6f94;text-align:center;padding:20px;font-size:12px; }
.adopt { display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap; }
.ad { flex:1;min-width:90px;background:#16263f;border:1px solid rgba(120,160,220,0.2);border-radius:9px;padding:10px;color:#dbe4f3;cursor:pointer;font-size:12px;display:flex;flex-direction:column;align-items:center;gap:4px; }
.ad span { color:#ffc107;font-size:11px; }
.animal { display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.a-icon{font-size:20px;}
.hp{display:flex;align-items:center;gap:4px;}
.hp .bar{flex:1;height:5px;background:#0c1730;border-radius:3px;overflow:hidden;width:90px;}
.hp .bar i{display:block;height:100%;}
.tiny{font-size:9px;color:#8ba2c8;width:26px;}
.ready{color:#ffd54f;font-size:11px;}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;}
.bag-item{background:#16263f;border:1px solid rgba(120,160,220,0.12);border-radius:9px;padding:10px;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:12px;color:#dbe4f3;}
.b-icon{font-size:22px;}
.b-qty{color:#ffd54f;}
.b-cat{font-size:9px;color:#6f84ab;}
/* 生产队列 */
.queue-stat{font-size:12px;color:#aebadd;margin-bottom:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.queue-stat b{color:#a5d6a7;font-size:14px;}
.queue-stat b.full{color:#ef9a9a;}
.proc-ctl{display:flex;gap:5px;flex-shrink:0;}
.recipe .m-info .tag{white-space:nowrap;}
.tag.lock{color:#ef9a9a;background:#3a1f1f;}
.job{display:flex;align-items:center;gap:8px;padding:9px 0;border-bottom:1px dashed rgba(120,160,220,0.1);}
.job.done{background:rgba(67,160,71,0.08);border-radius:8px;padding-left:6px;padding-right:6px;}
.job.canceled{opacity:.62;}
.job-state{font-size:10px;font-weight:400;margin-left:6px;padding:2px 6px;border-radius:4px;}
.job-state.running{color:#90caf9;background:#122a47;}
.job-state.done{color:#a5d6a7;background:#1b3a21;}
.job-state.canceled{color:#8ba2c8;background:#23304a;}
.job-bar{width:100%;height:4px;background:#0c1730;border-radius:3px;overflow:hidden;margin-top:3px;}
.job-bar i{display:block;height:100%;background:linear-gradient(90deg,#2962ff,#5c97ff);transition:width .3s;}
.job.done .job-bar i{background:#43a047;}
h4 .collect-all{margin-left:auto;font-size:11px;}
/* 协作排产 */
.held-sum{font-size:11px;color:#8ba2c8;margin-bottom:8px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;}
.held-sum .tag.held{color:#ffd54f;background:#2d2814;border:1px solid rgba(255,213,79,0.25);}
.held-sum .tag.tip{color:#6f84ab;}
.reorder-ctl{display:flex;flex-direction:column;gap:2px;flex-shrink:0;width:24px;}
.reorder-ctl.placeholder{visibility:hidden;}
.mini.arrow{padding:1px 0;font-size:9px;line-height:1.2;background:#16263f;border:1px solid rgba(120,160,220,0.25);border-radius:5px;}
.mini.arrow:disabled{opacity:.4;}
.creator{font-size:10px;font-weight:400;color:#8ba2c8;margin-left:8px;white-space:nowrap;}
.live-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:#4a5a78;margin-left:3px;vertical-align:middle;}
.live-dot.on{background:#66bb6a;box-shadow:0 0 4px #66bb6a;}
.tag.held-line{color:#ffd54f;background:transparent;padding:2px 4px 0;display:flex;gap:8px;flex-wrap:wrap;}
.tag.held-line i{font-style:normal;color:#c9b27a;}
.tag.held-line i.gen{color:#ce93d8;}
.tag.gen, .held-sum .tag.gen{color:#ce93d8;background:#2a1b3d;}
.job .mini[disabled]{cursor:not-allowed;}
</style>