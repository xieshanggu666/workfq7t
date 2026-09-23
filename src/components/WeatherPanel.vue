<template>
  <div class="panel weather-panel" :class="{bad: w?.bad}" v-if="w">
    <h3>
      {{ w.icon }} 天气 · {{ w.name }}
      <span v-if="w.bad" class="sev">{{ '⚠'.repeat(w.severity) }}</span>
    </h3>
    <p class="w-desc">{{ w.desc }}</p>
    <p class="w-dur" v-if="w.bad">持续 {{ w.duration }} 天 · 剩余 {{ w.duration - w.settled_days }} 天</p>

    <template v-if="w.bad">
      <div class="divider"></div>
      <div class="p-row">🛡️ 防护储备：<b>🪙{{ w.protect_gold }}</b> · <b>物资×{{ w.protect_mat }}</b></div>
      <div class="p-row upkeep">每日全防护消耗：🪙{{ w.upkeepGold }} + 物资×{{ w.upkeepMat }}</div>
      <div class="p-btns">
        <button @click="store.protect(20, 0)">+🪙20</button>
        <button @click="store.protect(50, 0)">+🪙50</button>
        <button :disabled="matCount < 1" @click="store.protect(0, 1)">+物资×1</button>
        <button :disabled="matCount < 3" @click="store.protect(0, 3)">+物资×3</button>
      </div>
      <p class="p-hint">物资可在市场购买（当前持有 ×{{ matCount }}）；事件结束返还剩余金币，物资不退。跳日时按天自动结算防护消耗。</p>
    </template>
    <p class="p-hint" v-else>天气良好，无需防护。恶劣天气来临时可在此投入金币与物资防灾。</p>

    <template v-if="store.weatherLog.length">
      <div class="divider"></div>
      <div class="w-log">
        <div class="wl-item" v-for="l in store.weatherLog" :key="l.id">{{ l.msg }}</div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useGameStore } from '@/store/game'
const store = useGameStore()
const w = computed(() => store.weather)
const matCount = computed(() =>
  store.inventory.filter((it) => it.cat === 'material').reduce((s, it) => s + it.qty, 0)
)
</script>

<style scoped>
.panel { background:#0f1b38;border:1px solid rgba(120,160,220,0.16);border-radius:12px;padding:14px; }
.panel.bad { border-color:rgba(239,83,80,0.45); }
h3 { margin:0 0 6px;color:#fff;font-size:15px;display:flex;align-items:center;gap:6px; }
.sev { color:#ef5350;font-size:12px;letter-spacing:1px; }
.w-desc { color:#8ba2c8;font-size:12px;margin:0 0 4px; }
.w-dur { color:#ffb74d;font-size:12px;margin:0 0 4px; }
.divider { height:1px;background:rgba(120,160,220,0.15);margin:10px 0; }
.p-row { color:#c6d2e6;font-size:12px;margin-bottom:4px; }
.p-row b { color:#ffd54f; }
.upkeep { color:#8ba2c8;font-size:11px; }
.p-btns { display:flex;gap:6px;margin:8px 0 6px;flex-wrap:wrap; }
.p-btns button {
  flex:1;min-width:64px;background:#2962ff;border:none;color:#fff;border-radius:7px;
  padding:7px 4px;font-size:12px;cursor:pointer;font-weight:600;
}
.p-btns button:hover { filter:brightness(1.15); }
.p-btns button:disabled { background:#2a3a5e;color:#6f84ab;cursor:not-allowed; }
.p-hint { color:#5b6f94;font-size:10px;margin:4px 0 0;line-height:1.5; }
.w-log { max-height:120px;overflow-y:auto; }
.wl-item { font-size:11px;color:#8ba2c8;padding:3px 0;border-bottom:1px dashed rgba(120,160,220,0.1); }
.wl-item:last-child { border-bottom:none; }
</style>
