<template>
  <div class="canvas-wrap">
    <canvas ref="cv" :width="W" :height="H" @click="onClick" @mousemove="onMove" @mouseleave="hoverCell = null"></canvas>
    <div class="irr-ctl">
      <button :class="{on: store.irrBuildMode==='reservoir'}" @click="store.setIrrBuildMode('reservoir')">🛢️ 蓄水池 🪙{{ store.irrigationCosts.reservoir }}</button>
      <button :class="{on: store.irrBuildMode==='canal'}" @click="store.setIrrBuildMode('canal')">➖ 水渠 🪙{{ store.irrigationCosts.canal }}</button>
    </div>
    <div class="map-tip build" v-if="store.irrBuildMode">
      {{ store.irrBuildMode === 'reservoir' ? '🛢️ 点击空地放置蓄水池' : '➖ 点击空地铺设水渠（可连续铺设）' }} · 再点右上角按钮取消
    </div>
    <div class="map-tip" v-else-if="store.selectedPlot">
      已选中地块 ({{ store.selectedPlot.x }},{{ store.selectedPlot.y }}) · 点击其他耕地切换
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useGameStore } from '@/store/game'

const store = useGameStore()
const cv = ref(null)
const TILE = 60
const W = 900
const H = 620
let ctx = null
let raf = null
let time = 0
const hoverCell = ref(null)

function tile(pos) { return pos * TILE }

function draw() {
  if (!ctx) return
  time++
  ctx.clearRect(0, 0, W, H)
  drawBackground()
  drawBuildings()
  drawPlots()
  drawIrrigation()
  drawGhost()
  drawAnimals()
}

function drawBackground() {
  const seasons = ['#cde8b8', '#dff0b0', '#ecd9a8', '#e8e6ef']
  const sky = ['#bfe3ff', '#d9f2ff', '#f5e9c8', '#dfe3f5']
  ctx.fillStyle = sky[store.currentSeason % 4]
  ctx.fillRect(0, 0, W, H)
  // 草地
  ctx.fillStyle = seasons[store.currentSeason % 4]
  ctx.fillRect(0, 40, W, H)
  // 简单网格背景植物点缀
  ctx.fillStyle = 'rgba(0,80,0,0.06)'
  for (let i = 0; i < 40; i++) {
    const px = (i * 97 + time) % W
    const py = 60 + ((i * 53) % (H - 80))
    ctx.beginPath(); ctx.arc(px, py, 3, 0, 7); ctx.fill()
  }
  // 天气氛围
  const wt = store.weather?.type
  const tints = {
    rain: 'rgba(40,80,160,0.15)', storm: 'rgba(20,30,60,0.28)', blizzard: 'rgba(255,255,255,0.35)',
    freeze: 'rgba(180,210,255,0.25)', frost: 'rgba(200,220,255,0.2)', heatwave: 'rgba(255,120,0,0.12)',
    drought: 'rgba(255,200,60,0.15)', wind: 'rgba(150,150,150,0.1)'
  }
  if (tints[wt]) {
    ctx.fillStyle = tints[wt]
    ctx.fillRect(0, 0, W, H)
  }
  if (wt && wt !== 'sunny') {
    ctx.font = '26px serif'
    ctx.textAlign = 'right'
    ctx.textBaseline = 'top'
    ctx.fillText(store.weather.icon, W - 12, 8)
  }
}

function drawBuildings() {
  const bdefs = {
    manure: { e: '🏠', w: 2, h: 2 },
    mill: { e: '⚙️', w: 2, h: 2 },
    barn: { e: '🐖', w: 2, h: 2 },
    market: { e: '🏪', w: 2, h: 2 },
    breed: { e: '🧬', w: 2, h: 2 }
  }
  const names = { 农舍: 'manure', 加工坊: 'mill', 畜棚: 'barn', 市场: 'market', 育种棚: 'breed' }
  for (const b of store.buildings) {
    const d = bdefs[names[b.name]] || bdefs.manure
    const x = tile(b.x)
    const y = tile(b.y)
    ctx.fillStyle = 'rgba(120,80,40,0.25)'
    ctx.fillRect(x + 2, y + 2, TILE * d.w - 4, TILE * d.h - 4)
    ctx.strokeStyle = 'rgba(120,80,40,0.4)'
    ctx.strokeRect(x + 2, y + 2, TILE * d.w - 4, TILE * d.h - 4)
    ctx.font = (TILE * d.w) + 'px serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(d.e, x + TILE * d.w / 2, y + TILE * d.h / 2)
    // 名称 + 等级
    ctx.font = '12px sans-serif'
    ctx.fillStyle = 'rgba(0,0,0,0.75)'
    ctx.fillText(b.name + ' Lv.' + b.level, x + TILE * d.w / 2, y + TILE * d.h - 6)
    // 升级高亮
    ctx.fillStyle = '#ffd54f'
    ctx.fillText('🔧', x + TILE * d.w - 16, y + 12)
  }
}

function drawPlots() {
  for (const p of store.plots) {
    if (p.x > 5 || p.y > 5) continue
    const x = tile(p.x)
    const y = tile(p.y) + 30
    // 耕地底
    ctx.fillStyle = '#8d6e52'
    ctx.fillRect(x, y, TILE, TILE)
    ctx.strokeStyle = '#6d5139'
    ctx.strokeRect(x, y, TILE, TILE)
    const sel = store.selectedPlot?.id === p.id
    if (sel) {
      ctx.save()
      ctx.strokeStyle = '#ffd54f'
      ctx.lineWidth = 3
      ctx.strokeRect(x - 2, y - 2, TILE + 4, TILE + 4)
      ctx.restore()
    }
    if (p.crop_id) {
      const crop = store.allCrops.find((c) => c.id === p.crop_id)
      if (crop) drawCrop(x, y, p, crop)
    }
    // 状态标记
    if (p.crop_id) {
      drawStatus(x, y, p)
    }
    // 灌溉接通标记
    if (p.irrigated) {
      ctx.font = '11px sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('💧', x + TILE - 11, y + 12)
    }
  }
}

function drawCrop(x, y, plot, crop) {
  const full = plot.stage >= (crop.days - 1)
  const ratio = Math.min(plot.stage, crop.days - 1) / Math.max(crop.days - 1, 1)
  // 生长进度条
  const px = x + 4, py = y + 4, pw = TILE - 8
  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.fillRect(px, py, pw, 5)
  ctx.fillStyle = full ? '#ffd54f' : '#8bc34a'
  ctx.fillRect(px, py, pw * Math.max(ratio, 0.08), 5)
  // 作物图形随阶段变化
  const grown = ratio > 0.5
  ctx.font = (grown ? 26 : 16) + 'px serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  if (!grown) ctx.font = '20px serif'
  ctx.globalAlpha = 0.5 + ratio * 0.5
  ctx.fillText(grown || full ? crop.sprite : '🌱', x + TILE / 2, y + TILE / 2 + 4)
  ctx.globalAlpha = 1
  if (full) {
    ctx.font = '10px sans-serif'
    ctx.fillStyle = '#ffd54f'
    ctx.fillText('成熟', x + TILE / 2, y + TILE / 2 + 18)
  }
  // 杂交品种标记
  if (crop.isVariety) {
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText('🧬', x + 3, y + 11)
  }
}

function drawStatus(x, y, p) {
  const ctxStatus = (val, color, dx) => {
    ctx.fillStyle = color
    ctx.font = '11px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(val <= 25 ? '⚠' + Math.round(val) : '' + Math.round(val), x + TILE / 2 + dx, y + TILE - 8)
  }
  // 状态指示三色小圆点
  const dot = (ok, dx) => {
    ctx.fillStyle = ok ? '#4caf50' : '#ef5350'
    ctx.beginPath(); ctx.arc(x + TILE / 2 + dx, y - 4, 4, 0, 7); ctx.fill()
  }
  dot(p.water >= 30, -12); dot(p.fert >= 30, 0); dot(p.light >= 30 && p.pest <= 0.6, 12)
}

// ===== 灌溉设施 =====
function facilityAt(gx, gy) { return store.irrigation.find((f) => f.x === gx && f.y === gy) }
function plotAt(gx, gy) { return store.plots.find((p) => p.x === gx && p.y === gy) }

function drawIrrigation() {
  for (const f of store.irrigation) {
    const x = tile(f.x)
    const y = tile(f.y) + 30
    if (f.kind === 'canal') drawCanal(x, y, f)
    else drawReservoir(x, y, f)
  }
}

// 水渠：向相邻设施/地块方向画水路，通水的亮蓝、未连通的暗蓝、停用的灰色
function drawCanal(x, y, f) {
  const cx = x + TILE / 2
  const cy = y + TILE / 2
  const color = !f.active ? '#7d8a94' : f.linked ? '#4fc3f7' : '#8fa8bd'
  ctx.strokeStyle = 'rgba(93,64,55,0.85)'
  ctx.lineWidth = 14
  ctx.lineCap = 'round'
  ctx.beginPath()
  let linked = false
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (facilityAt(f.x + dx, f.y + dy) || plotAt(f.x + dx, f.y + dy)) {
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + dx * TILE / 2, cy + dy * TILE / 2)
      linked = true
    }
  }
  if (!linked) { ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy) }
  ctx.stroke()
  // 水流层（通水时带流动高光）
  ctx.strokeStyle = color
  ctx.lineWidth = 8
  ctx.beginPath()
  if (!linked) { ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy) }
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (facilityAt(f.x + dx, f.y + dy) || plotAt(f.x + dx, f.y + dy)) {
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + dx * TILE / 2, cy + dy * TILE / 2)
    }
  }
  ctx.stroke()
  if (f.active && f.linked) {
    ctx.fillStyle = `rgba(255,255,255,${0.25 + 0.2 * Math.sin(time / 6 + f.id)})`
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, 7); ctx.fill()
  }
  if (!f.active) drawPaused(x, y)
}

// 蓄水池：池壁 + 按水量比例的水面，停用则灰化
function drawReservoir(x, y, f) {
  const cap = f.cap || 150
  const ratio = Math.max(0, Math.min(1, f.water / cap))
  // 池壁
  ctx.fillStyle = '#5d4037'
  ctx.fillRect(x + 5, y + 8, TILE - 10, TILE - 14)
  ctx.fillStyle = '#3e2723'
  ctx.fillRect(x + 8, y + 11, TILE - 16, TILE - 20)
  // 水面（随时间轻微波动）
  const wh = (TILE - 22) * ratio
  if (wh > 0) {
    ctx.fillStyle = f.active ? '#29b6f6' : '#78909c'
    const wave = Math.sin(time / 10 + f.id) * 1.5
    ctx.fillRect(x + 9, y + 12 + (TILE - 22 - wh) + wave * 0.3, TILE - 18, wh)
    ctx.fillStyle = 'rgba(255,255,255,0.25)'
    ctx.fillRect(x + 9, y + 12 + (TILE - 22 - wh) + wave * 0.3, TILE - 18, 2)
  }
  // 水位文字
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#fff'
  ctx.fillText(Math.round(f.water) + '', x + TILE / 2, y + TILE - 8)
  if (!f.active) drawPaused(x, y)
}

function drawPaused(x, y) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)'
  ctx.fillRect(x, y, TILE, TILE)
  ctx.font = '14px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('⏸', x + TILE / 2, y + TILE / 2)
}

// 建造模式：悬停格幽灵预览（绿可建/红不可建）
function canBuildAt(gx, gy) {
  if (gx < 0 || gy < 0 || gx >= 15 || gy >= 10) return false
  if (plotAt(gx, gy)) return false
  if (facilityAt(gx, gy)) return false
  for (const b of store.buildings) {
    if (gx >= b.x && gx < b.x + 2 && gy >= b.y && gy < b.y + 2) return false
  }
  return true
}
function drawGhost() {
  if (!store.irrBuildMode || !hoverCell.value) return
  const { x: gx, y: gy } = hoverCell.value
  if (gx < 0 || gy < 0 || gx >= 15 || gy >= 10) return
  const ok = canBuildAt(gx, gy)
  const x = tile(gx)
  const y = tile(gy) + 30
  ctx.fillStyle = ok ? 'rgba(76,175,80,0.35)' : 'rgba(239,83,80,0.35)'
  ctx.fillRect(x, y, TILE, TILE)
  ctx.strokeStyle = ok ? '#4caf50' : '#ef5350'
  ctx.lineWidth = 2
  ctx.strokeRect(x + 1, y + 1, TILE - 2, TILE - 2)
  ctx.font = '18px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(store.irrBuildMode === 'reservoir' ? '🛢️' : '➖', x + TILE / 2, y + TILE / 2)
}

function drawAnimals() {
  for (const a of store.animals) {
    const x = tile(a.x) + 6
    const y = tile(a.y) + 36
    const icons = { chicken: '🐔', cow: '🐄', sheep: '🐑' }
    const bob = Math.sin(time / 8 + a.id) * 3
    const scale = 1 + (a.feed < 40 ? -0.3 : 0)
    ctx.font = (22 * scale) + 'px serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = Math.max(0.4, a.feed / 100)
    ctx.fillText(icons[a.species], x, y + bob)
    ctx.globalAlpha = 1
    if (a.ready) {
      ctx.font = '9px sans-serif'
      ctx.fillStyle = '#ffd54f'
      ctx.fillText('●可收集', x, y + 16)
    }
  }
}

function cellFromEvent(e) {
  const rect = cv.value.getBoundingClientRect()
  const xx = Math.floor(((e.clientX - rect.left) / rect.width) * W / TILE)
  const yy = Math.floor(((e.clientY - rect.top) / rect.height) * (H - 30) / TILE)
  return { x: xx, y: yy }
}

function onMove(e) {
  if (!store.irrBuildMode) { hoverCell.value = null; return }
  hoverCell.value = cellFromEvent(e)
}

function onClick(e) {
  const { x: xx, y: yy } = cellFromEvent(e)
  // 灌溉放置模式：点击空地建造
  if (store.irrBuildMode) {
    store.buildIrrigation(store.irrBuildMode, xx, yy)
    return
  }
  const plot = store.plots.find((p) => p.x === xx && p.y === yy && p.x <= 5 && p.y <= 5)
  if (plot) store.selectPlot(plot.id)
  else store.selectPlot(null)
}

onMounted(() => {
  ctx = cv.value.getContext('2d')
  const loop = () => { draw(); raf = requestAnimationFrame(loop) }
  loop()
})
onBeforeUnmount(() => { cancelAnimationFrame(raf) })
</script>

<style scoped>
.canvas-wrap { position: relative; background: #bfe3ff; border-radius: 10px; overflow: hidden; }
canvas { display: block; width: 100%; height: auto; cursor: crosshair; }
.map-tip {
  position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.6);
  color: #ffd54f; padding: 4px 10px; border-radius: 6px; font-size: 12px;
}
.map-tip.build { color: #4fc3f7; }
.irr-ctl { position: absolute; top: 8px; right: 8px; display: flex; gap: 6px; }
.irr-ctl button {
  background: rgba(13,40,64,0.85); border: 1px solid rgba(79,195,247,0.4); color: #b3e5fc;
  border-radius: 7px; padding: 5px 10px; font-size: 12px; cursor: pointer;
}
.irr-ctl button.on { background: #0277bd; color: #fff; border-color: #4fc3f7; }
</style>