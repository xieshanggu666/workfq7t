<template>
  <div class="page breed-page">
    <!-- 左：开始新试验 -->
    <div class="pcol card">
      <h4>🧬 育种棚 <span class="lvl">Lv.{{ b.labLevel }}</span></h4>
      <div class="queue-stat">
        进行中试验 <b :class="{full: b.running >= b.capacity}">{{ b.running }}/{{ b.capacity }}</b> 组
        <span class="tag">每组投入两批作物各 2 个 + 🪙{{ b.goldCost }}</span>
      </div>

      <div class="parent-pick" v-for="(side, key) in sides" :key="key">
        <span class="pp-label">{{ side === 'A' ? '父本 ♂' : '母本 ♀' }}</span>
        <select v-model="pick[key]" class="pp-select">
          <option value="">— 选择库存作物 —</option>
          <option v-for="c in parentCrops" :key="c.ref" :value="c.ref" :disabled="c.qty < needOf(key, c.ref)">
            {{ c.icon }} {{ c.name }}{{ c.isVariety ? '🧬' : '' }} ×{{ c.qty }}{{ c.qty < needOf(key, c.ref) ? '（不足）' : '' }}
          </option>
        </select>
        <span class="pp-traits">
          <i v-for="t in traitsOfRef(pick[key])" :key="t.k"
             :class="{ bad: !t.good }" :title="t.name + '：' + t.desc">{{ t.icon }}</i>
        </span>
      </div>

      <button class="wide start" :disabled="!canStart || !store.can('breedStart')"
              :title="store.can('breedStart') ? '' : '仅管理员/场主可发起杂交试验'"
              @click="doStart">
        🧪 开始杂交试验（🪙{{ b.goldCost }}，各耗 {{ PARENT_QTY }} 个）
      </button>
      <p v-if="!store.can('breedStart')" class="perm-hint">🔒 发起杂交试验需要管理员或场主权限；试验开始后所有成员都可浇水/施肥/照料。</p>
      <p class="hint">
        子代有概率继承双亲性状，也可能突变出新品种；跨作物杂交（如萝卜×番茄）子代本源随机取一方。
        成熟后产出的新品种种子可在「地块操作」中播种。
      </p>

      <button class="wide" :disabled="!store.can('upgrade')" :title="store.can('upgrade') ? '' : '仅场主可升级建筑'"
              @click="store.upgradeBuilding(b.labId)">
        🔧 升级育种棚（🪙{{ b.labLevel * 40 }}）→ 同时进行更多组试验
      </button>
    </div>

    <!-- 右：试验进度 -->
    <div class="pcol card">
      <h4>🧪 试验田</h4>
      <div v-if="!trials.length" class="none">还没有试验，从左侧选择两批作物开始杂交吧</div>
      <div v-for="t in trials" :key="t.id" class="trial" :class="t.status">
        <div class="tr-head">
          <b>#{{ t.id }} {{ t.parent_a_icon }} {{ t.parent_a_name }} × {{ t.parent_b_icon }} {{ t.parent_b_name }}</b>
          <span class="tr-state" :class="t.status">{{ stateLabel(t) }}</span>
        </div>

        <!-- 亲本 / 子代性状 -->
        <div class="tr-traits">
          <span class="tt-col">
            <em>父本</em>
            <template v-if="t.parent_a_traits.length"><i v-for="k in t.parent_a_traits" :key="k" :class="{bad:!traitDef(k).good}" :title="traitDef(k).desc">{{ traitDef(k).icon }}</i></template>
            <em v-else class="plain">普通</em>
          </span>
          <span class="tt-arrow">🧬</span>
          <span class="tt-col">
            <em>子代</em>
            <template v-if="t.traits.length"><i v-for="k in t.traits" :key="k" :class="{bad:!traitDef(k).good}" :title="traitDef(k).name+'：'+traitDef(k).desc">{{ traitDef(k).icon }}<small>{{ traitDef(k).name }}</small></i></template>
            <em v-else class="plain">普通</em>
          </span>
        </div>

        <!-- 进行中：四维 + 养护 -->
        <template v-if="t.status === 'running'">
          <div class="tr-bars">
            <div class="tb"><span>💧</span><div class="bar"><i :style="{width:t.water+'%',background:barColor(t.water)}"></i></div><em>{{ Math.round(t.water) }}</em></div>
            <div class="tb"><span>🟫</span><div class="bar"><i :style="{width:t.fert+'%',background:barColor(t.fert)}"></i></div><em>{{ Math.round(t.fert) }}</em></div>
            <div class="tb"><span>❤️</span><div class="bar"><i :style="{width:t.health+'%',background:barColor(t.health)}"></i></div><em>{{ Math.round(t.health) }}</em></div>
            <div class="tb"><span>🧑‍🌾</span><div class="bar"><i :style="{width:t.care+'%',background:'#ab47bc'}"></i></div><em>{{ Math.round(t.care) }}</em></div>
          </div>
          <div class="tr-progress">
            发育 {{ t.progress }}/{{ t.days_total }} 天<span v-if="t.blocked_days"> · 受阻 {{ t.blocked_days }} 天</span>
            <div class="pbar"><i :style="{width:(t.progress/t.days_total*100)+'%'}"></i></div>
          </div>
          <div class="tr-actions">
            <button class="mini" @click="store.careBreeding(t.id,'water')">💧 浇水</button>
            <button class="mini" @click="store.careBreeding(t.id,'fert')">🟫 施肥</button>
            <button class="mini" @click="store.careBreeding(t.id,'tend')">🧑‍🌾 照料</button>
            <button class="mini red" @click="cancelT(t)">放弃</button>
          </div>
        </template>

        <!-- 完成：结果 -->
        <div v-else-if="t.status === 'done'" class="tr-result">
          ✅ 培育成功：<b>{{ t.variety?.sprite }} {{ t.variety?.name }}</b> 种子 ×{{ t.result_seeds }} 已入背包
          <span class="tag">💰售价{{ t.variety?.price }}</span>
          <span class="tag">{{ t.variety?.days }}天成熟</span>
          <span class="tag">第{{ t.variety?.gen }}代</span>
        </div>
        <div v-else class="tr-result fail">🥀 试验失败，亲本损耗，再接再厉</div>
      </div>
    </div>

    <!-- 品种图鉴 + 谱系 -->
    <div class="pcol card full">
      <h4>📖 品种图鉴与谱系</h4>
      <div v-if="!store.varieties.length" class="none">尚未培育出新品种</div>
      <div v-for="v in store.varieties" :key="v.id" class="variety">
        <span class="v-icon">{{ v.sprite }}</span>
        <div class="v-info">
          <b>{{ v.name }} <span class="tag gen">第{{ v.gen }}代</span></b>
          <div class="v-traits">
            <i v-for="k in (v.traits||[])" :key="k" :class="{bad:!traitDef(k).good}" :title="traitDef(k).name+'：'+traitDef(k).desc">
              {{ traitDef(k).icon }} {{ traitDef(k).name }}
            </i>
          </div>
          <div class="pedigree">
            <PedigreeNode :ref="v.id + ''" :is-var="true" :depth="0" />
          </div>
        </div>
        <div class="v-stats">
          <span class="tag">{{ v.days }}天成熟</span>
          <span class="tag">💰{{ v.price }}</span>
          <span class="tag">宜{{ ['春','夏','秋','冬'][v.season] }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, h } from 'vue'
import { useGameStore } from '@/store/game'

const store = useGameStore()
const b = computed(() => store.breeding)
const trials = computed(() => b.value?.trials || [])
const PARENT_QTY = 2

const pick = ref({ A: '', B: '' })
const sides = { A: 'A', B: 'B' }

// 库存中可作亲本的作物（基础 + 品种），合并展示
const parentCrops = computed(() => {
  const list = []
  for (const c of store.allCrops) {
    const itemId = c.isVariety ? 'crop-v' + c.id : 'crop-' + c.id
    const qty = store.inventory.find((it) => it.item_id === itemId)?.qty || 0
    if (qty > 0) list.push({ ref: (c.isVariety ? 'var:' : 'base:') + c.id, name: c.name, icon: c.sprite, qty, isVariety: c.isVariety, traits: c.traits || [] })
  }
  return list
})
function needOf(side, ref) {
  // 同一作物同时做父本与母本时需要 4 个
  const other = side === 'A' ? pick.value.B : pick.value.A
  return other === ref ? PARENT_QTY * 2 : PARENT_QTY
}
const canStart = computed(() => {
  if (!pick.value.A || !pick.value.B) return false
  if (b.value.running >= b.value.capacity) return false
  const a = parentCrops.value.find((c) => c.ref === pick.value.A)
  const bb = parentCrops.value.find((c) => c.ref === pick.value.B)
  if (!a || !bb) return false
  return a.qty >= needOf('A', a.ref) && bb.qty >= needOf('B', bb.ref)
})
async function doStart() {
  try {
    await store.startBreeding(pick.value.A, pick.value.B)
    pick.value = { A: '', B: '' }
  } catch { /* toast 已提示 */ }
}
function cancelT(t) {
  if (confirm(`放弃试验 #${t.id}？已投入的亲本作物不会退还。`)) store.cancelBreeding(t.id)
}
function traitDef(k) { return b.value?.traits?.[k] || { name: k, icon: '•', good: true, desc: '' } }
function traitsOfRef(ref) {
  const c = parentCrops.value.find((x) => x.ref === ref)
  return (c?.traits || []).map((k) => ({ k, ...traitDef(k) }))
}
function stateLabel(t) {
  if (t.status === 'done') return '✓ 已成熟'
  if (t.status === 'failed') return '失败'
  return t.blocked_days > 0 ? `发育中·受阻${t.blocked_days}天` : `发育中·剩${t.remain}天`
}
function barColor(v) { return v < 30 ? '#ef5350' : v < 60 ? '#ffb300' : '#4caf50' }

// ===== 谱系树：递归渲染，基础作物为根 =====
const PedigreeNode = {
  name: 'PedigreeNode',
  props: { ref: String, isVar: Boolean, depth: Number },
  setup(props) {
    return () => {
      const store = useGameStore()
      if (props.depth > 8) return h('span', { class: 'pn plain' }, '…')
      if (!props.isVar) {
        const base = store.crops.find((c) => c.id === Number(props.ref))
        return h('span', { class: 'pn base' }, `${base?.sprite || ''}${base?.name || '?'}`)
      }
      const v = store.varieties.find((x) => x.id === Number(props.ref))
      if (!v) return h('span', { class: 'pn plain' }, '未知品种')
      const parse = (r) => {
        const [kind, id] = String(r).split(':')
        return { ref: id, isVar: kind === 'var' }
      }
      const pa = parse(v.parent_a)
      const pb = parse(v.parent_b)
      return h('span', { class: 'pn var' }, [
        h('span', { class: 'pn-self' }, `${v.sprite}${v.name}`),
        h('span', { class: 'pn-parents' }, [
          h(PedigreeNode, { ref: pa.ref, isVar: pa.isVar, depth: props.depth + 1 }),
          ' × ',
          h(PedigreeNode, { ref: pb.ref, isVar: pb.isVar, depth: props.depth + 1 })
        ])
      ])
    }
  }
}
</script>

<style scoped>
.page { display:grid;grid-template-columns:1fr 1fr;gap:16px; }
.page .full { grid-column:1 / -1; }
@media(max-width:760px){ .page{grid-template-columns:1fr;} }
.pcol { display:flex;flex-direction:column;gap:2px; }
.card { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:16px; }
h4 { margin:0 0 8px;color:#fff;display:flex;gap:8px;align-items:center; }
.lvl { font-size:11px;color:#ffd54f; }
.queue-stat{font-size:12px;color:#aebadd;margin-bottom:10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.queue-stat b{color:#a5d6a7;font-size:14px;}
.queue-stat b.full{color:#ef9a9a;}
.tag { font-size:10px;color:#6f84ab;background:#16263f;padding:2px 6px;border-radius:4px; }
.tag.gen { color:#ce93d8; }
.hint { color:#5b6f94;font-size:10px;line-height:1.6;margin:8px 0; }
.perm-hint { color:#ffb74d;font-size:10px;line-height:1.6;margin:6px 0; }
.wide { width:100%;margin-top:10px;background:#16263f;border:1px solid rgba(255,213,79,0.3);color:#ffd54f;border-radius:9px;padding:10px;font-size:13px;cursor:pointer; }
.wide.start { background:linear-gradient(135deg,#6a1b9a,#8e24aa);color:#fff;border-color:transparent;font-weight:600; }
.wide:disabled { opacity:.5;cursor:not-allowed; }
.none { color:#5b6f94;text-align:center;padding:20px;font-size:12px; }
.mini { background:#2962ff;border:none;color:#fff;border-radius:7px;padding:6px 10px;font-size:12px;cursor:pointer; }
.mini.red { background:#c62828; }
.mini:hover{filter:brightness(1.15);}

.parent-pick { display:flex;align-items:center;gap:8px;margin-bottom:8px; }
.pp-label { width:48px;color:#ce93d8;font-size:12px;font-weight:600; }
.pp-select { flex:1;background:#16263f;border:1px solid rgba(120,160,220,0.25);color:#dbe4f3;border-radius:8px;padding:8px;font-size:12px; }
.pp-select option { background:#0f1b38; }
.pp-traits { display:flex;gap:2px;min-width:44px; }
.pp-traits i, .v-traits i, .tt-col i { font-style:normal;font-size:14px; }
.pp-traits i.bad, .v-traits i.bad, .tt-col i.bad { filter:grayscale(.2); }

.trial { background:#13223e;border:1px solid rgba(120,160,220,0.12);border-radius:10px;padding:10px 12px;margin-bottom:10px; }
.trial.done { border-color:rgba(102,187,106,0.4);background:rgba(67,160,71,0.07); }
.trial.failed { border-color:rgba(239,83,80,0.35);opacity:.8; }
.tr-head { display:flex;justify-content:space-between;align-items:center;gap:6px; }
.tr-head b { color:#e8eefb;font-size:12px; }
.tr-state { font-size:10px;padding:2px 7px;border-radius:4px;background:#122a47;color:#90caf9;white-space:nowrap; }
.tr-state.done { color:#a5d6a7;background:#1b3a21; }
.tr-state.failed { color:#ef9a9a;background:#3a1f1f; }
.tr-traits { display:flex;gap:8px;align-items:center;margin:8px 0;font-size:13px; }
.tt-col { display:inline-flex;gap:3px;align-items:center; }
.tt-col em { font-style:normal;font-size:10px;color:#6f84ab;margin-right:2px; }
.tt-col i { position:relative; }
.tt-col i small { position:absolute;left:50%;top:-8px;transform:translateX(-50%);font-size:8px;color:#c6d2e6;white-space:nowrap; }
.tt-col i.bad { color:#ef9a9a; }
.tt-col em.plain { color:#5b6f94; }
.tt-arrow { color:#ce93d8; }
.tr-bars { display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-bottom:6px; }
.tb { display:flex;align-items:center;gap:5px;font-size:11px; }
.tb > span { width:16px; }
.tb em { font-style:normal;color:#ffd54f;font-size:10px;width:24px;text-align:right; }
.bar { flex:1;height:6px;background:#0c1730;border-radius:3px;overflow:hidden;min-width:40px; }
.bar i { display:block;height:100%; }
.tr-progress { font-size:10px;color:#8ba2c8;margin-bottom:6px; }
.pbar { height:4px;background:#0c1730;border-radius:3px;overflow:hidden;margin-top:3px; }
.pbar i { display:block;height:100%;background:linear-gradient(90deg,#8e24aa,#ce93d8); }
.tr-actions { display:flex;gap:6px;flex-wrap:wrap; }
.tr-result { font-size:12px;color:#c6d2e6;display:flex;gap:6px;align-items:center;flex-wrap:wrap; }
.tr-result b { color:#a5d6a7; }
.tr-result.fail { color:#ef9a9a; }

.variety { display:flex;gap:10px;padding:10px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.variety:last-child { border-bottom:none; }
.v-icon { font-size:24px; }
.v-info { flex:1;min-width:0; }
.v-info b { color:#e8eefb;font-size:13px; }
.v-traits { display:flex;gap:8px;margin:3px 0;flex-wrap:wrap; }
.v-traits i { font-size:11px;color:#a5d6a7;background:#1b3a21;padding:1px 6px;border-radius:4px;font-style:normal; }
.v-traits i.bad { color:#ef9a9a;background:#3a1f1f; }
.v-stats { display:flex;flex-direction:column;gap:3px;align-items:flex-end; }
.pedigree { font-size:10px;color:#6f84ab;margin-top:2px;line-height:1.7; }
:deep(.pn) { display:inline-flex;flex-direction:column; }
:deep(.pn-parents) { color:#5b6f94;font-size:10px;padding-left:8px;border-left:1px dotted rgba(120,160,220,0.3);margin-left:2px; }
:deep(.pn-self) { color:#ce93d8; }
:deep(.pn.base) { color:#8ba2c8; }
:deep(.pn.plain) { color:#5b6f94; }
</style>
