<template>
  <div class="panel irr-panel">
    <h3>💧 灌溉系统</h3>

    <!-- 建造（管理员+） -->
    <div class="build-row">
      <button class="build-btn" :class="{on: store.irrBuildMode==='reservoir', deny: !store.can('irrigBuild')}"
              :disabled="!store.can('irrigBuild')"
              @click="store.setIrrBuildMode('reservoir')">
        🛢️ 蓄水池 <span class="cost">🪙{{ store.irrigationCosts.reservoir }}</span>
      </button>
      <button class="build-btn" :class="{on: store.irrBuildMode==='canal', deny: !store.can('irrigBuild')}"
              :disabled="!store.can('irrigBuild')"
              @click="store.setIrrBuildMode('canal')">
        ➖ 水渠 <span class="cost">🪙{{ store.irrigationCosts.canal }}/段</span>
      </button>
    </div>
    <p class="perm-tip" v-if="!store.can('irrigBuild')">🔒 建造/拆除灌溉设施需要管理员或场主权限，你可以查看网络并停用/启用设施、设置地块水分。</p>
    <p class="hint" v-if="store.irrBuildMode">
      点击地图空地放置{{ store.irrBuildMode === 'reservoir' ? '蓄水池' : '水渠（可连续铺设）' }}，再次点击按钮取消
    </p>
    <p class="hint" v-else>蓄水池储水，水渠连接蓄水池与耕地；每日结算时自动为连通地块浇水</p>

    <div class="divider"></div>

    <!-- 供水概览 -->
    <div class="net-row">
      <span>🛢️ 总储量 <b>{{ totalWater }}/{{ totalCap }}</b></span>
      <span>🌾 供水地块 <b :class="{warn: irrigatedCount < plantedCount}">{{ irrigatedCount }}/{{ plantedCount }}</b></span>
    </div>
    <div class="bar total"><i :style="{width: totalCap ? (totalWater/totalCap*100)+'%' : '0%'}"></i></div>

    <!-- 供水网络：连通的多座蓄水池统一分水 -->
    <div class="net-list" v-if="store.irrigationNetworks.length">
      <div class="net" v-for="n in store.irrigationNetworks" :key="n.id">
        <span class="net-name">🕸️ 网络#{{ n.id }}</span>
        <span>🛢️×{{ n.reservoirs }}</span>
        <span>💧 {{ Math.round(n.water) }}/{{ n.cap }}</span>
        <span>🌾 {{ n.plots }} 块地</span>
      </div>
    </div>

    <!-- 每日分配结果：缺水时展示逐地块明细 -->
    <div class="report" v-if="report">
      <div class="rp-head" :class="{warn: report.totals.shortCount > 0}">
        {{ report.totals.shortCount ? '⚠️' : '✅' }} 第{{ report.absDay }}天供水结算：
        {{ report.totals.fed }} 块地共供水 {{ report.totals.used }}
        <template v-if="report.totals.shortCount">；{{ report.totals.shortCount }} 块地缺水 {{ report.totals.shortAmount }}</template>
      </div>
      <div class="rp-plots" v-if="report.totals.shortCount > 0">
        <div class="rp-row" v-for="r in reportPlots" :key="r.netId + '-' + r.plotId" :class="{short: r.short > 0}">
          <span class="rp-crop">{{ r.sprite }} {{ r.crop }} ({{ r.x }},{{ r.y }})</span>
          <span class="rp-nums">💧{{ r.before }}→{{ r.after }} / 🎯{{ r.target }}</span>
          <span class="rp-flag" :class="r.short > 0 ? 'lack' : 'ok'">{{ r.short > 0 ? '缺' + r.short : '浇足' }}</span>
        </div>
      </div>
    </div>

    <!-- 设施列表 -->
    <div class="fac-list" v-if="store.irrigation.length">
      <div class="fac" v-for="f in sortedFacilities" :key="f.id" :class="{off: !f.active}">
        <span class="f-icon">{{ f.kind === 'reservoir' ? '🛢️' : '➖' }}</span>
        <div class="f-info">
          <b>{{ f.kind === 'reservoir' ? '蓄水池' : '水渠' }} ({{ f.x }},{{ f.y }})</b>
          <div class="bar" v-if="f.kind === 'reservoir'">
            <i :style="{width: (f.water / f.cap * 100) + '%'}"></i>
          </div>
          <span class="f-state" :class="stateClass(f)">{{ stateText(f) }}</span>
        </div>
        <button class="mini" @click="store.toggleIrrigation(f.id)">{{ f.active ? '停用' : '启用' }}</button>
        <button class="mini red" :disabled="!store.can('irrigDemolish')" @click="demolish(f)">拆除</button>
      </div>
    </div>
    <div class="none" v-else>还没有灌溉设施，先建一座蓄水池吧</div>

    <p class="hint rules">
      规则：地块可设目标水分与保水优先级；每日结算时，同一连通网络内的蓄水池统一分水，
      按 优先级高→低、预计最快缺水者优先（结合天气与品种耗水估算）浇到目标水分，水量耗尽即止；
      降雨为蓄水池补水，干旱加速蒸发；停用/拆除即断流并重算供水网络，缺水分配结果见上方结算。
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useGameStore } from '@/store/game'
const store = useGameStore()

const sortedFacilities = computed(() =>
  [...store.irrigation].sort((a, b) => (a.kind === b.kind ? a.id - b.id : a.kind === 'reservoir' ? -1 : 1))
)
const reservoirs = computed(() => store.irrigation.filter((f) => f.kind === 'reservoir'))
const totalWater = computed(() => reservoirs.value.reduce((s, f) => s + f.water, 0))
const totalCap = computed(() => reservoirs.value.reduce((s, f) => s + (f.cap || 0), 0))
const irrigatedCount = computed(() => store.plots.filter((p) => p.crop_id && p.irrigated).length)
const plantedCount = computed(() => store.plots.filter((p) => p.crop_id).length)

// 最近一次供水结算：有供水或缺水时展示；缺水时展开逐地块分配明细（缺口大的排前）
const report = computed(() => {
  const r = store.irrigationReport
  return r && (r.totals?.fed || r.totals?.shortCount) ? r : null
})
const reportPlots = computed(() => {
  if (!report.value) return []
  const rows = []
  for (const n of report.value.networks || []) {
    for (const pl of n.plots || []) rows.push({ ...pl, netId: n.id })
  }
  return rows.sort((a, b) => (b.short - a.short) || (b.priority - a.priority) || (a.plotId - b.plotId))
})

function stateText(f) {
  if (!f.active) return '已停用 · 断流'
  if (f.kind === 'reservoir') return f.water > 0 ? `💧 ${Math.round(f.water)}/${f.cap}` : '干涸 · 等待降雨'
  return f.linked ? '通水中' : '未连通蓄水池'
}
function stateClass(f) {
  if (!f.active) return 'off'
  if (f.kind === 'reservoir') return f.water > 0 ? 'ok' : 'warn'
  return f.linked ? 'ok' : 'warn'
}
function demolish(f) {
  const tip = f.kind === 'reservoir' && f.water > 0 ? `，池内 ${Math.round(f.water)} 水量将作废` : ''
  if (confirm(`确定拆除${f.kind === 'reservoir' ? '蓄水池' : '水渠'} (${f.x},${f.y}) 吗${tip}？`)) {
    store.demolishIrrigation(f.id)
  }
}
</script>

<style scoped>
.panel { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px; }
h3 { margin:0 0 10px;color:#fff;font-size:15px; }
.build-row { display:flex;gap:8px; }
.build-btn {
  flex:1;background:#16263f;border:1px solid rgba(120,160,220,0.25);border-radius:9px;
  padding:10px;color:#dbe4f3;cursor:pointer;font-size:12px;display:flex;flex-direction:column;gap:4px;align-items:center;
}
.build-btn.on { border-color:#29b6f6;box-shadow:0 0 0 1px #29b6f6;background:#12314f; }
.build-btn:disabled, .build-btn.deny { opacity:.45;cursor:not-allowed; }
.perm-tip { color:#ffb74d;font-size:10px;margin:6px 0 0;line-height:1.5; }
.cost { color:#ffc107;font-size:11px; }
.hint { color:#8ba2c8;font-size:11px;margin:8px 0 0;line-height:1.5; }
.hint.rules { color:#5b6f94;border-top:1px dashed rgba(120,160,220,0.15);padding-top:8px; }
.divider { height:1px;background:rgba(120,160,220,0.15);margin:10px 0; }
.net-row { display:flex;justify-content:space-between;font-size:12px;color:#c6d2e6;margin-bottom:5px; }
.net-row b { color:#4fc3f7; }
.net-row b.warn { color:#ef9a9a; }
.bar { height:8px;background:#0c1730;border-radius:4px;overflow:hidden; }
.bar i { display:block;height:100%;background:linear-gradient(90deg,#0288d1,#4fc3f7);border-radius:4px; }
.bar.total { margin-bottom:10px; }
.net-list { display:flex;flex-direction:column;gap:4px;margin-bottom:10px; }
.net {
  display:flex;gap:10px;align-items:center;background:#12233f;border:1px solid rgba(79,195,247,0.18);
  border-radius:7px;padding:5px 9px;font-size:11px;color:#9fb4d8;
}
.net .net-name { color:#4fc3f7;font-weight:600; }
.report { background:#12233f;border:1px solid rgba(120,160,220,0.16);border-radius:8px;padding:8px 10px;margin-bottom:10px; }
.rp-head { font-size:11px;color:#a5d6a7;line-height:1.5; }
.rp-head.warn { color:#ffb74d; }
.rp-plots { max-height:150px;overflow-y:auto;margin-top:6px; }
.rp-row {
  display:flex;align-items:center;gap:6px;font-size:10px;color:#8ba2c8;
  padding:3px 0;border-bottom:1px dashed rgba(120,160,220,0.1);
}
.rp-row:last-child { border-bottom:none; }
.rp-row.short { color:#ef9a9a; }
.rp-crop { flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
.rp-nums { white-space:nowrap; }
.rp-flag { white-space:nowrap;padding:1px 5px;border-radius:4px; }
.rp-flag.lack { color:#ffb74d;background:#3a2a12; }
.rp-flag.ok { color:#a5d6a7;background:#1b3a21; }
.fac-list { max-height:220px;overflow-y:auto; }
.fac { display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.fac:last-child { border-bottom:none; }
.fac.off { opacity:.6; }
.f-icon { font-size:18px;width:26px;text-align:center; }
.f-info { flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:4px;align-items:center; }
.f-info b { color:#e8eefb;font-size:12px;width:100%; }
.f-info .bar { flex:1;min-width:60px; }
.f-state { font-size:10px;padding:2px 6px;border-radius:4px;background:#16263f;color:#8ba2c8;white-space:nowrap; }
.f-state.ok { color:#a5d6a7;background:#1b3a21; }
.f-state.warn { color:#ffb74d;background:#3a2a12; }
.f-state.off { color:#8ba2c8;background:#23304a; }
.mini { background:#2962ff;border:none;color:#fff;border-radius:7px;padding:5px 9px;font-size:11px;cursor:pointer;white-space:nowrap; }
.mini.red { background:#c62828; }
.mini:hover { filter:brightness(1.15); }
.none { color:#5b6f94;text-align:center;padding:14px;font-size:12px; }
</style>
