import { defineStore } from 'pinia'

const LS_TOKEN = 'farm_token'
const LS_FARM = 'farm_farm_id'
const LS_NAME = 'farm_user_name'

// 每个标签页独立的客户端 id：同一账号开两个窗口时，彼此仍能收到对方操作的同步广播
let clientId = null
if (typeof crypto !== 'undefined' && crypto.randomUUID) clientId = crypto.randomUUID()
else clientId = 'c' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)

async function api(path, method = 'GET', body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' }
  const token = localStorage.getItem(LS_TOKEN)
  if (token) headers['X-Auth-Token'] = token
  if (gameStoreRef?.farmId) headers['X-Farm-Id'] = gameStoreRef.farmId
  if (clientId) headers['X-Client-Id'] = clientId
  // 乐观并发：携带当前状态版本，服务端发现已被其他端改动则返回 409
  if (gameStoreRef?.version != null && method !== 'GET') headers['X-State-Version'] = String(gameStoreRef.version)
  Object.assign(headers, opts.headers || {})
  const opt = { method, headers }
  if (body) opt.body = JSON.stringify(body)
  const r = await fetch('/api' + path, opt)
  if (r.status === 401) {
    localStorage.removeItem(LS_TOKEN)
    throw Object.assign(new Error('登录已过期，请重新进入'), { code: 'AUTH' })
  }
  // 旧农场尚未认领：写操作要求先认领。首个用户自动原子认领后重试一次（与 /me 行为一致）
  if (r.status === 428 && method !== 'GET' && !opts.__retry) {
    const rc = await fetch('/api/coop/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Auth-Token': token }
    })
    if (rc.ok) return api(path, method, body, { ...opts, __retry: true })
  }
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(data.error || '请求失败'), { code: data.error, status: r.status, data })
  return data
}

// api() 需要访问 store 实例，模块加载后注入
let gameStoreRef = null

export const useGameStore = defineStore('game', {
  state: () => ({
    // ===== 账号 / 共营 =====
    user: null,
    token: localStorage.getItem(LS_TOKEN) || null,
    myFarms: [],
    farmId: Number(localStorage.getItem(LS_FARM)) || 1,
    coopDetail: null,        // 当前农场的成员/邀请/在线详情
    evt: null,               // EventSource
    evtConnected: false,
    pendingName: localStorage.getItem(LS_NAME) || '',

    // ===== 游戏存档 =====
    loaded: false,
    version: 0,
    role: null,
    unclaimed: false,
    farm: null,
    online: [],
    player: null,
    crops: [],
    varieties: [],
    inventory: [],
    buildings: [],
    animals: [],
    plots: [],
    weather: null,
    weatherLog: [],
    recipes: [],
    productionJobs: [],
    productionReserved: [],
    queueCapacity: 0,
    queuedBatches: 0,
    breeding: null,
    irrigation: [],
    irrigationCosts: { reservoir: 60, canal: 8 },
    irrigationNetworks: [],
    irrigationReport: null,
    irrBuildMode: null,
    selectedPlotId: null,
    seedMode: false,
    selectedCropId: null,
    toast: null,
    timeline: []
  }),
  getters: {
    seasonLabel: (s) => {
      const map = ['🌸 春', '☀️ 夏', '🍂 秋', '❄️ 冬']
      return s.player ? map[s.player.season % 4] : '🌸 春'
    },
    currentSeason: (s) => s.player?.season ?? 0,
    selectedPlot: (s) => s.plots.find((p) => p.id === s.selectedPlotId) || null,
    // 权限：未加载完成前不开放任何操作
    can: (s) => (perm) => {
      if (!s.role) return false
      if (s.role === 'owner') return true
      // 管理员：成员全部权限 + 时间推进/灾害/设施/育种试验/邀请
      if (s.role === 'admin') {
        return !['memberRole', 'transfer', 'disband', 'upgrade'].includes(perm)
      }
      // 成员可用权限白名单（与服务端 ROLE_PERMS.member 对齐）
      return ['plant', 'water', 'fertilize', 'clean', 'harvest', 'protect', 'buymat', 'buyseed',
        'sellcrop', 'adopt', 'feed', 'collect', 'enqueue', 'cancelJob', 'collectJob', 'reorderJob',
        'irrigToggle', 'irrigPriority', 'irrigTarget', 'careTrial', 'cancelTrial'].includes(perm)
    },
    // 管理员+
    canManage: (s) => s.role === 'admin' || s.role === 'owner',
    canOwner: (s) => s.role === 'owner',
    // 协作排产：成员只能管理自己排产的工单（无排产人记录的旧工单视为公共），管理员可管理任意
    canManageJob: (s) => (j) => {
      if (!s.role) return false
      if (s.role === 'owner' || s.role === 'admin') return true
      return !j?.creator?.id || j.creator.id === s.user?.id
    },
    onlineUserIds: (s) => new Set((s.online || []).map((u) => u.id)),
    activeFarms: (s) => s.myFarms.filter((f) => f.status === 'active'),
    // 统一作物表：基础作物 + 杂交品种（id 均唯一）
    allCrops: (s) => {
      const vars = (s.varieties || []).map((v) => ({
        id: v.id, name: v.name, days: v.days, season: v.season,
        price: v.price, seedPrice: v.seed_price, sprite: v.sprite,
        traits: v.traits || [], gen: v.gen, base_id: v.base_id, isVariety: true
      }))
      return [...s.crops.map((c) => ({ ...c, traits: [], gen: 0, base_id: c.id, isVariety: false })), ...vars]
    }
  },
  actions: {
    // ===== 账号 =====
    async register(name) {
      const d = await api('/register', 'POST', { name })
      this.setSession(d.token, d.user)
      return d
    },
    async restoreMe() {
      const d = await api('/me')
      this.user = d.user
      this.myFarms = d.farms || []
      // 自动选择：记忆中的农场仍在团 → 用它；否则选第一个在团农场；都没有则回到农场大厅（默认 farm 1 仅访客）
      const remembered = this.myFarms.find((f) => f.id === this.farmId && f.status === 'active')
      if (!remembered) {
        const first = this.myFarms.find((f) => f.status === 'active')
        this.farmId = first?.id || 1
        localStorage.setItem(LS_FARM, String(this.farmId))
      }
      return d
    },
    setSession(token, user) {
      this.token = token
      this.user = user
      localStorage.setItem(LS_TOKEN, token)
      if (user?.name) localStorage.setItem(LS_NAME, user.name)
    },
    logout() {
      this.stopEvents()
      localStorage.removeItem(LS_TOKEN)
      this.token = null
      this.user = null
    },

    // ===== 农场切换 / 共营 =====
    async switchFarm(farmId) {
      this.farmId = farmId
      localStorage.setItem(LS_FARM, String(farmId))
      this.loaded = false
      this.stopEvents()
      await this.load()
    },
    async createFarm(name) {
      const d = await api('/coop/farms', 'POST', { name })
      await this.restoreMe()
      await this.switchFarm(d.farm.id)
      return d.farm
    },
    async joinFarm(code) {
      const d = await api('/coop/join', 'POST', { code })
      await this.restoreMe()
      await this.switchFarm(d.farmId)
      return d
    },
    async claimFarm() {
      await api('/coop/claim', 'POST')
      await this.restoreMe()
    },
    async leaveFarm() {
      await api('/coop/leave', 'POST')
      await this.restoreMe()
      const first = this.myFarms.find((f) => f.status === 'active')
      await this.switchFarm(first?.id || 1)
    },
    async disbandFarm() {
      await api('/coop/disband', 'POST')
      this.stopEvents()
      await this.restoreMe()
      const first = this.myFarms.find((f) => f.status === 'active')
      this.farmId = first?.id || 1
      localStorage.setItem(LS_FARM, String(this.farmId))
      this.loaded = false
    },
    async loadCoopDetail() {
      try {
        this.coopDetail = await api('/coop/farms/' + this.farmId)
      } catch { this.coopDetail = null }
    },
    async createInvite(role = 'member', maxUses = 1, ttlMs) {
      return (await api('/coop/invites', 'POST', { role, maxUses, ttlMs })).invite
    },
    async revokeInvite(code) {
      return api('/coop/invites/revoke', 'POST', { code })
    },
    async setMemberRole(userId, role) {
      await api('/coop/members/role', 'POST', { userId, role })
      await this.loadCoopDetail()
    },
    async transferFarm(userId) {
      await api('/coop/transfer', 'POST', { userId })
      await Promise.all([this.loadCoopDetail(), this.load()])
    },

    // ===== SSE 实时通道 =====
    startEvents() {
      this.stopEvents()
      if (!this.token) return
      const url = `/api/events?farmId=${this.farmId}&token=${encodeURIComponent(this.token)}`
      const es = new EventSource(url)
      this.evt = es
      es.onopen = () => { this.evtConnected = true }
      es.addEventListener('hello', () => { this.evtConnected = true })
      es.addEventListener('presence', (e) => {
        try {
          const d = JSON.parse(e.data)
          this.online = d.users || []
          if (this.coopDetail) this.coopDetail.online = this.online
        } catch { /* ignore */ }
      })
      es.addEventListener('mutation', (e) => {
        try {
          const d = JSON.parse(e.data)
          // 自己当前标签页的请求已在本地处理，仅对齐版本即可（同账号另一窗口的操作仍会同步）
          if (d.clientId === clientId) {
            this.version = d.version
            return
          }
          // 其他成员的操作：静默同步存档；他人推进时间/育种/加工类变更给出提示
          this.version = d.version
          this.load({ silent: true })
          const byName = d.by?.name ? `（${d.by.name}）` : ''
          this.pushLog(`🔄 ${ACTION_LABELS[d.action] || '农场'}已被同伴更新${byName}`, 'sync')
        } catch { /* ignore */ }
      })
      es.addEventListener('disbanded', () => {
        this.showToast('农场已被场主解散', 'warn')
        this.stopEvents()
        this.restoreMe().then(() => {
          const first = this.myFarms.find((f) => f.status === 'active')
          this.switchFarm(first?.id || 1)
        })
      })
      es.onerror = () => { this.evtConnected = false } // 浏览器会自动重连
    },
    stopEvents() {
      if (this.evt) {
        this.evt.close()
        this.evt = null
      }
      this.evtConnected = false
    },

    // ===== 存档加载 =====
    async load(opts = {}) {
      const d = await api('/state')
      this.version = d.version
      this.role = d.role
      this.unclaimed = d.unclaimed
      this.farm = d.farm
      this.online = d.online || []
      this.player = d.player
      this.crops = d.crops
      this.varieties = d.varieties || []
      this.inventory = d.inventory
      this.buildings = d.buildings
      this.animals = d.animals
      this.plots = d.plots
      this.weather = d.weather
      this.weatherLog = d.weatherLog || []
      this.recipes = d.recipes || []
      this.productionJobs = d.productionJobs || []
      this.productionReserved = d.productionReserved || []
      this.queueCapacity = d.queueCapacity || 0
      this.queuedBatches = d.queuedBatches || 0
      this.breeding = d.breeding || null
      this.irrigation = d.irrigation || []
      this.irrigationCosts = d.irrigationCosts || this.irrigationCosts
      this.irrigationNetworks = d.irrigationNetworks || []
      this.irrigationReport = d.irrigationReport || null
      this.loaded = true
      if (!opts.silent && this.canManage) this.loadCoopDetail()
    },
    pushLog(msg, type = 'info') {
      this.timeline.unshift({ msg, type, time: new Date().toLocaleTimeString('zh-CN') })
      if (this.timeline.length > 30) this.timeline.pop()
    },
    showToast(msg, type = 'info') {
      this.toast = { msg, type, id: Date.now() }
      this.pushLog(msg, type === 'sync' ? 'sync' : 'info')
    },
    clearToast() { this.toast = null },

    async refresh() { await this.load() },

    // 统一执行写操作：409 状态冲突时自动重拉并提示，不中断协作
    async _commit(fn, { denyPerm } = {}) {
      if (denyPerm && !this.can(denyPerm)) {
        this.showToast('权限不足：该操作需要管理员或场主', 'warn')
        return null
      }
      try {
        return await fn()
      } catch (e) {
        if (e.code === 'state_stale' || e.status === 409) {
          await this.load()
          this.showToast('有同伴刚刚先操作了，状态已同步，请重试', 'warn')
        } else {
          this.showToast(e.message, 'warn')
        }
        return null
      }
    },

    async plant() {
      if (!this.selectedPlot || !this.selectedCropId) return
      const r = await this._commit(async () => {
        const d = await api('/plant', 'POST', { plotId: this.selectedPlot.id, cropId: this.selectedCropId })
        await this.load({ silent: true })
        return d
      }, { denyPerm: 'plant' })
      if (r) this.selectedCropId = null
    },
    async water() {
      if (!this.selectedPlot) return
      await this._commit(async () => {
        await api('/water', 'POST', { plotId: this.selectedPlot.id })
        await this.load({ silent: true })
      }, { denyPerm: 'water' })
    },
    async fertilize() {
      if (!this.selectedPlot) return
      await this._commit(async () => {
        await api('/fertilize', 'POST', { plotId: this.selectedPlot.id })
        await this.load({ silent: true })
      }, { denyPerm: 'fertilize' })
    },
    async clean() {
      if (!this.selectedPlot) return
      await this._commit(async () => {
        await api('/clean', 'POST', { plotId: this.selectedPlot.id })
        await this.load({ silent: true })
      }, { denyPerm: 'clean' })
    },
    async harvest() {
      if (!this.selectedPlot) return
      const r = await this._commit(async () => {
        const d = await api('/harvest', 'POST', { plotId: this.selectedPlot.id })
        await this.load({ silent: true })
        return d
      }, { denyPerm: 'harvest' })
      if (r) this.showToast(`收获 ${r.yield} ×${r.qty || 1} +${r.gold}金${r.variety ? '🧬' : ''}`, 'success')
    },
    async nextDay(n = 1) {
      if (!this.canManage) { this.showToast('只有管理员/场主可以推进时间与灾害结算', 'warn'); return }
      const r = await this._commit(async () => {
        const d = await api('/skip', 'POST', { n })
        await this.load({ silent: true })
        return d
      }, { denyPerm: 'nextday' })
      if (!r) return
      const logs = r.logs || []
      logs.forEach((m) => { if (!m.startsWith('✅') && !m.startsWith('🧬')) this.pushLog(m, 'warn') })
      const done = logs.filter((m) => m.startsWith('✅') || m.startsWith('🧬'))
      if (done.length) this.showToast(done[0], 'success')
      else this.showToast(`时间 +${n} 天`, 'info')
    },
    async protect(gold, matQty) {
      await this._commit(async () => {
        await api('/weather/protect', 'POST', { gold, matQty })
        await this.load({ silent: true })
        this.showToast('已投入防护资源', 'success')
      }, { denyPerm: 'protect' })
    },
    async buyMat(qty = 1) {
      await this._commit(async () => {
        await api('/buymat', 'POST', { qty })
        await this.load({ silent: true })
        this.showToast('已购入防灾物资', 'success')
      }, { denyPerm: 'buymat' })
    },
    async buySeed(cropId, qty = 1) {
      await this._commit(async () => {
        await api('/buyseed', 'POST', { cropId, qty })
        await this.load({ silent: true })
        this.showToast('已购买种子', 'success')
      }, { denyPerm: 'buyseed' })
    },
    async sellCrop(cropId, qty = 1) {
      await this._commit(async () => {
        const r = await api('/sellcrop', 'POST', { cropId, qty })
        await this.load({ silent: true })
        this.showToast(`售出${r.sold}，+${r.gain}金`, 'success')
      }, { denyPerm: 'sellcrop' })
    },
    async buyAnimal(species) {
      await this._commit(async () => {
        await api('/animal', 'POST', { species })
        await this.load({ silent: true })
        this.showToast('已领养', 'success')
      }, { denyPerm: 'adopt' })
    },
    async feedAnimal(id) {
      const r = await this._commit(async () => {
        await api('/feed', 'POST', { id })
        await this.load({ silent: true })
        return true
      }, { denyPerm: 'feed' })
      return r
    },
    async collectAnimal(id) {
      await this._commit(async () => {
        const r = await api('/collect', 'POST', { id })
        await this.load({ silent: true })
        this.showToast(`收集 ${r.item} +${r.gold}金`, 'success')
      }, { denyPerm: 'collect' })
    },
    async enqueueProduction(recipeId, qty) {
      const r = await this._commit(async () => {
        await api('/production/enqueue', 'POST', { recipeId, qty })
        await this.load({ silent: true })
        return true
      }, { denyPerm: 'enqueue' })
      if (r) this.showToast(`已排产 ${qty} 批，开工后按天自动推进`, 'success')
      return r
    },
    async cancelProduction(id) {
      await this._commit(async () => {
        const r = await api('/production/cancel', 'POST', { id })
        await this.load({ silent: true })
        if (r.refundBatches > 0) {
          const items = (r.refunds || []).map((it) => `${it.name}×${it.qty}`).join('、')
          this.showToast(`已取消，退回 ${r.refundBatches} 批原料：${items}`, 'info')
        } else this.showToast('已取消（无未开工批次可退料）', 'info')
      }, { denyPerm: 'cancelJob' })
    },
    async reorderProduction(id, dir) {
      const r = await this._commit(async () => {
        const d = await api('/production/reorder', 'POST', { id, dir })
        await this.load({ silent: true })
        return d
      }, { denyPerm: 'reorderJob' })
      return r
    },
    async collectProduction(id = null) {
      await this._commit(async () => {
        const r = await api('/production/collect', 'POST', id == null ? {} : { id })
        await this.load({ silent: true })
        const text = r.picked.map((p) => `${p.name}×${p.qty}`).join('、')
        this.showToast(`完工入库：${text}`, 'success')
      }, { denyPerm: 'collectJob' })
    },
    async upgradeBuilding(id) {
      await this._commit(async () => {
        await api('/upgrade', 'POST', { id })
        await this.load({ silent: true })
        this.showToast('建筑升级成功', 'success')
      }, { denyPerm: 'upgrade' })
    },

    // ===== 灌溉 =====
    setIrrBuildMode(kind) {
      if (kind && !this.can('irrigBuild') && this.irrBuildMode !== kind) {
        this.showToast('建造灌溉设施需要管理员权限', 'warn')
        return
      }
      this.irrBuildMode = this.irrBuildMode === kind ? null : kind
    },
    async buildIrrigation(kind, x, y) {
      await this._commit(async () => {
        await api('/irrigation/build', 'POST', { kind, x, y })
        await this.load({ silent: true })
        this.showToast(kind === 'reservoir' ? '蓄水池已建成，铺设水渠连接地块吧' : '水渠已铺设', 'success')
        if (kind === 'reservoir') this.irrBuildMode = null
      }, { denyPerm: 'irrigBuild' })
    },
    async toggleIrrigation(id) {
      await this._commit(async () => {
        const r = await api('/irrigation/toggle', 'POST', { id })
        await this.load({ silent: true })
        this.showToast(r.active ? '已启用，恢复供水' : '已停用，供水网络断流', 'info')
      }, { denyPerm: 'irrigToggle' })
    },
    async demolishIrrigation(id) {
      await this._commit(async () => {
        const r = await api('/irrigation/demolish', 'POST', { id })
        await this.load({ silent: true })
        this.showToast(`已拆除，返还 🪙${r.refund}`, 'info')
      }, { denyPerm: 'irrigDemolish' })
    },
    async setIrrPriority(plotId, priority) {
      await this._commit(async () => {
        await api('/irrigation/priority', 'POST', { plotId, priority })
        await this.load({ silent: true })
      }, { denyPerm: 'irrigPriority' })
    },
    async setIrrTarget(plotId, target) {
      await this._commit(async () => {
        await api('/irrigation/target', 'POST', { plotId, target })
        await this.load({ silent: true })
      }, { denyPerm: 'irrigTarget' })
    },

    // ===== 杂交育种 =====
    async startBreeding(parentA, parentB) {
      const r = await this._commit(async () => {
        await api('/breeding/start', 'POST', { parentA, parentB })
        await this.load({ silent: true })
        return true
      }, { denyPerm: 'breedStart' })
      if (r) this.showToast('🧬 杂交试验已开始，随游戏天推进，注意浇水施肥与防灾', 'success')
      return r
    },
    async careBreeding(id, action) {
      await this._commit(async () => {
        await api('/breeding/care', 'POST', { id, action })
        await this.load({ silent: true })
      }, { denyPerm: 'careTrial' })
    },
    async cancelBreeding(id) {
      await this._commit(async () => {
        await api('/breeding/cancel', 'POST', { id })
        await this.load({ silent: true })
        this.showToast('试验已取消（亲本已消耗不退）', 'info')
      }, { denyPerm: 'cancelTrial' })
    },

    selectPlot(id) {
      this.selectedPlotId = id
    },
    setSeedMode(s) { this.seedMode = s }
  }
})

// SSE 收到同伴操作时的中文动作名（时间线提示用）
const ACTION_LABELS = {
  plant: '播种', water: '浇水', fertilize: '施肥', clean: '除虫', harvest: '收获',
  nextday: '时间推进/灾害结算', protect: '防灾投入', buymat: '购买物资', buyseed: '购买种子',
  sellcrop: '出售作物', adopt: '领养动物', feed: '喂食', collect: '收集产物',
  'production/enqueue': '加工排产', 'production/cancel': '取消工单', 'production/reorder': '队列重排', 'production/collect': '加工入库',
  'irrigation/build': '建造灌溉设施', 'irrigation/toggle': '灌溉设施启停', 'irrigation/demolish': '拆除灌溉设施',
  'irrigation/priority': '灌溉优先级', 'irrigation/target': '灌溉目标水分',
  'breeding/start': '杂交试验', 'breeding/care': '试验养护', 'breeding/cancel': '取消试验',
  upgrade: '建筑升级'
}

// 注入 store 引用给 api() 使用
export function bindGameStore(store) {
  gameStoreRef = store
}
