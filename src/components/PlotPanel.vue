<template>
  <div class="panel">
    <h3>🧑‍🌾 地块操作</h3>
    <div v-if="!store.selectedPlot" class="empty">点击上方网格中的耕地选择地块</div>
    <template v-else>
      <p class="info">地块 ({{ p.x }},{{ p.y }})</p>

      <!-- 状态条 -->
      <div class="stat">
        <span>💧 水分</span><div class="bar"><i :style="{width:p.water+'%',background: barColor(p.water)}"></i></div><b>{{ Math.round(p.water) }}</b>
      </div>
      <div class="stat">
        <span>🟫 肥力</span><div class="bar"><i :style="{width:p.fert+'%',background: barColor(p.fert)}"></i></div><b>{{ Math.round(p.fert) }}</b>
      </div>
      <div class="stat">
        <span>☀️ 光照</span><div class="bar"><i :style="{width:p.light+'%',background: barColor(p.light)}"></i></div><b>{{ Math.round(p.light) }}</b>
      </div>
      <div class="stat pest">
        <span>🐛 虫害</span><div class="bar"><i :style="{width: Math.min(100,p.pest*40)+'%',background:'#ef5350'}"></i></div><b>{{ p.pest>0?p.pest:'' }}</b>
      </div>

      <!-- 灌溉：接通状态 + 保水优先级 + 目标水分 -->
      <div class="irr-row">
        <span class="irr-state" :class="{on: p.irrigated}">{{ p.irrigated ? '💧 灌溉已接通' : '🚱 未接通水渠' }}</span>
        <span class="irr-prio">
          保水优先级
          <button v-for="(l, i) in ['低','中','高']" :key="i"
                  :class="{sel: (p.irr_priority ?? 1) === i}"
                  @click="store.setIrrPriority(p.id, i)">{{ l }}</button>
        </span>
      </div>
      <div class="irr-target">
        <span class="irr-target-label">
          🎯 目标水分 <b>{{ p.irr_target ?? 100 }}</b>
          <em v-if="!(p.irr_target ?? 100)">（不自动浇水）</em>
        </span>
        <input type="range" min="0" max="100" step="5"
               :value="p.irr_target ?? 100"
               @change="store.setIrrTarget(p.id, +$event.target.value)" />
      </div>
      <p class="irr-use" v-if="estUse != null">预计日耗水 ≈{{ estUse }}（灌溉按此与天气调度供水）</p>

      <div class="divider"></div>

      <!-- 空地：播种（仅显示背包中持有的种子，含杂交品种） -->
      <template v-if="!p.crop_id">
        <div v-if="!seedChoices.length" class="empty">背包里没有种子，去市场购买或育种棚培育吧</div>
        <div v-else class="seed-crops">
          <button v-for="c in seedChoices" :key="c.id"
                  class="seed-opt"
                  :class="{sel: store.selectedCropId===c.id}"
                  @click="store.selectedCropId = c.id">
            <span class="sc-icon">{{ c.sprite }}</span>
            <span class="sc-name">{{ c.name }}<em v-if="c.isVariety">🧬</em></span>
            <span class="sc-traits">
              <i v-for="t in c.traitIcons" :key="t.k" :class="{bad:!t.good}" :title="t.name+'：'+t.desc">{{ t.icon }}</i>
            </span>
            <span class="sc-days">{{ c.days }}天</span>
            <span class="sc-seed">×{{ c.qty }}</span>
          </button>
        </div>
        <button class="action primary" @click="store.plant()" :disabled="!store.selectedCropId">🌱 播种</button>
      </template>

      <!-- 已种：养护操作 -->
      <template v-else>
        <div class="crop-line">
          <span class="crop-sprite">{{ crop?.sprite }}</span>
          <span>{{ crop?.name }}<em v-if="crop?.isVariety" class="hybrid">🧬</em></span>
          <span class="stage" :class="{full:isGrown}">{{ isGrown ? '已成熟' : '生长 ' + p.stage + '/' + (crop?.days-1 || 0) }}</span>
        </div>
        <div class="plot-traits" v-if="crop?.isVariety && crop.traits.length">
          <i v-for="k in crop.traits" :key="k" :class="{bad:!traitDef(k).good}" :title="traitDef(k).name+'：'+traitDef(k).desc">
            {{ traitDef(k).icon }} {{ traitDef(k).name }}
          </i>
        </div>
        <div class="actions-grid">
          <button class="action" @click="store.water()">💧 浇水</button>
          <button class="action" @click="store.fertilize()">🟫 施肥</button>
          <button class="action" @click="store.clean()">🧹 除虫</button>
          <button class="action harvest" @click="store.harvest()">🧺 收获</button>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useGameStore } from '@/store/game'
const store = useGameStore()
const p = computed(() => store.selectedPlot || {})
const crop = computed(() => store.allCrops.find((c) => c.id === p.value.crop_id))
const isGrown = computed(() => crop.value && p.value.stage >= (crop.value.days - 1))
function barColor(v) { return v < 30 ? '#ef5350' : v < 60 ? '#ffb300' : '#4caf50' }
function traitDef(k) { return store.breeding?.traits?.[k] || { name: k, icon: '•', good: true, desc: '' } }

// 当前作物的预计日耗水（品种性状修正，与服务端调度估算口径一致；不含天气蒸发）
const estUse = computed(() => {
  if (!crop.value) return null
  const t = crop.value.traits || []
  let mul = 1
  if (t.includes('droughthardy')) mul *= 0.5
  if (t.includes('weak')) mul *= 1.5
  return Math.round(18 * mul)
})

// 背包中可播种的种子：seed-<基础id> 与 seed-v<品种id>
const seedChoices = computed(() => {
  const out = []
  for (const it of store.inventory.filter((x) => x.cat === 'seed')) {
    let c = null
    if (it.item_id.startsWith('seed-v')) {
      c = store.allCrops.find((x) => x.isVariety && x.id === Number(it.item_id.slice(6)))
    } else if (it.item_id.startsWith('seed-')) {
      c = store.allCrops.find((x) => !x.isVariety && x.id === Number(it.item_id.slice(5)))
    }
    if (c) out.push({ ...c, qty: it.qty, traitIcons: (c.traits || []).map((k) => ({ k, ...traitDef(k) })) })
  }
  return out
})
</script>

<style scoped>
.panel { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px; }
h3 { margin:0 0 10px;color:#fff;font-size:15px; }
.empty { color:#5b6f94;font-size:12px;padding:10px 0;text-align:center; }
.info { color:#8ba2c8;font-size:12px;margin:0 0 8px; }
.stat { display:flex;align-items:center;gap:6px;margin-bottom:5px;font-size:12px;color:#c6d2e6; }
.stat > span { width:58px; }
.stat b { min-width:24px;text-align:right;color:#ffd54f; }
.bar { flex:1;height:8px;background:#0c1730;border-radius:4px;overflow:hidden; }
.bar i { display:block;height:100%;border-radius:4px; }
.divider { height:1px;background:rgba(120,160,220,0.15);margin:10px 0; }
.irr-row { display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;font-size:11px; }
.irr-state { color:#8ba2c8; }
.irr-state.on { color:#4fc3f7; }
.irr-prio { display:flex;align-items:center;gap:3px;color:#6f84ab; }
.irr-prio button {
  background:#16263f;border:1px solid rgba(120,160,220,0.2);color:#8ba2c8;border-radius:5px;
  padding:2px 7px;font-size:10px;cursor:pointer;
}
.irr-prio button.sel { background:#0277bd;color:#fff;border-color:#29b6f6; }
.irr-target { display:flex;align-items:center;gap:8px;margin-top:6px;font-size:11px;color:#6f84ab; }
.irr-target-label { white-space:nowrap; }
.irr-target-label b { color:#4fc3f7; }
.irr-target-label em { font-style:normal;color:#8ba2c8; }
.irr-target input[type=range] { flex:1;accent-color:#29b6f6;height:14px;cursor:pointer; }
.irr-use { margin:4px 0 0;font-size:10px;color:#5b6f94; }

.seed-crops { display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;max-height:180px;overflow-y:auto; }
.seed-opt {
  display:flex;flex-direction:column;align-items:center;gap:2px;min-width:64px;
  background:#16263f;border:1px solid rgba(120,160,220,0.2);border-radius:8px;padding:6px 4px;
  cursor:pointer;color:#dbe4f3;font-size:11px;
}
.seed-opt.sel { border-color:#ffd54f;box-shadow:0 0 0 1px #ffd54f; }
.sc-icon { font-size:20px; }
.sc-days { color:#8ba2c8; }
.sc-seed { color:#ffc107; }
.sc-name em { font-style:normal;font-size:10px; }
.sc-traits { display:flex;gap:1px;height:12px; }
.sc-traits i { font-style:normal;font-size:10px; }
.sc-traits i.bad { filter:grayscale(.2); }
.plot-traits { display:flex;gap:6px;flex-wrap:wrap;margin:4px 0 6px; }
.plot-traits i { font-style:normal;font-size:10px;color:#a5d6a7;background:#1b3a21;padding:2px 6px;border-radius:4px; }
.plot-traits i.bad { color:#ef9a9a;background:#3a1f1f; }
.crop-line .hybrid { font-style:normal;font-size:10px; }

.action {
  width:100%;margin-top:6px;background:#4381ff;border:none;border-radius:9px;
  color:#fff;padding:10px;font-size:13px;cursor:pointer;font-weight:600;
}
.action.primary { background:linear-gradient(135deg,#43a047,#2e7d32); }
.action.harvest { background:linear-gradient(135deg,#ffb300,#f57c00); }
.action:hover { filter:brightness(1.1); }
.action:disabled { background:#2a3a5e;color:#6f84ab;cursor:not-allowed; }
.actions-grid { display:grid;grid-template-columns:1fr 1fr;gap:6px; }
.actions-grid .action { width:auto;margin-top:2px; }
.crop-line { display:flex;align-items:center;gap:8px;color:#dbe4f3;font-size:13px;margin-bottom:6px; }
.crop-sprite { font-size:22px; }
.stage { margin-left:auto;color:#8ba2c8;font-size:11px; }
.stage.full { color:#ffd54f;font-weight:700; }
</style>