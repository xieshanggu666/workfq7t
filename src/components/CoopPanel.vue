<template>
  <!-- 未登录：昵称注册 -->
  <div v-if="!store.token" class="coop-login card">
    <h2>🚜 像素农场 · 联机共营</h2>
    <p class="sub">设置昵称进入农场。农场支持邀请好友共营：成员负责种植/交易/生产/育种，管理员推进时间与防灾，场主管理成员与建筑。</p>
    <div class="login-row">
      <input v-model="name" maxlength="16" placeholder="输入你的昵称（最多16字）"
             @keyup.enter="doRegister" />
      <button class="btn primary" @click="doRegister">进入</button>
    </div>
    <p v-if="err" class="err">⚠️ {{ err }}</p>
    <p class="old-save">📦 旧的单人存档会自动保留，进入后即成为「我的农场」场主，可随时邀请好友一起经营。</p>
  </div>

  <!-- 农场大厅 -->
  <div v-else class="coop-hub">
    <header class="hub-bar">
      <div class="me">
        <span class="avatar">🧑‍🌾</span>
        <b>{{ store.user?.name }}</b>
        <span class="farm-name">🏡 {{ store.farm?.name }}</span>
        <span class="role-tag" :class="store.role">{{ roleLabel(store.role) }}</span>
        <span class="online-dot" :class="{on: store.evtConnected}"></span>
        <span class="online-text">{{ store.online.length }} 人在线</span>
      </div>
      <div class="hub-actions">
        <select v-model="switchTarget" @change="onSwitch" title="切换农场">
          <option v-for="f in store.myFarms" :key="f.id" :value="f.id">
            {{ f.status === 'left' ? '🚪 已退出·' : '' }}{{ f.name }}（{{ roleLabel(f.role) }}）
          </option>
        </select>
        <button class="btn" @click="showInvite = !showInvite">📨 邀请/成员</button>
        <button class="btn" @click="showCreate = !showCreate">➕ 新农场</button>
        <button class="btn close-btn" @click="emit('close')">✕ 关闭</button>
      </div>
    </header>

    <!-- 创建农场 -->
    <div v-if="showCreate" class="card create-box">
      <h3>创建一座新农场</h3>
      <p class="hint">新农场拥有独立存档：初始金币、耕地、种子与建筑，与其他农场互不影响。创建后你自动成为场主。</p>
      <div class="row-inline">
        <input v-model="newFarmName" maxlength="20" placeholder="农场名称，如：开心农场" @keyup.enter="doCreate" />
        <button class="btn primary" @click="doCreate">创建</button>
      </div>
      <p v-if="createErr" class="err">⚠️ {{ createErr }}</p>
    </div>

    <!-- 加入农场 -->
    <div class="card join-box">
      <h3>加入好友的农场</h3>
      <p class="hint">输入场主或管理员分享的 8 位邀请码即可加入；曾退出的农场也可凭新邀请码回归。</p>
      <div class="row-inline">
        <input v-model="joinCode" maxlength="8" class="code-input" placeholder="邀请码，如 K7PQ2T9X"
               @input="joinCode = joinCode.toUpperCase()" @keyup.enter="doJoin" />
        <button class="btn primary" @click="doJoin">加入</button>
      </div>
      <p v-if="joinErr" class="err">⚠️ {{ joinErr }}</p>
    </div>

    <!-- 成员与邀请管理 -->
    <div v-if="showInvite" class="card invite-box">
      <h3>👥 成员与邀请 · {{ store.farm?.name }}</h3>

      <!-- 旧单人存档尚未认领 -->
      <div v-if="store.unclaimed" class="claim-row warn-box">
        这是待认领的旧单人存档，当前以访客身份操作。
        <button class="btn primary" @click="doClaim">📦 认领为我的农场（成为场主）</button>
      </div>

      <table class="members" v-if="detail">
        <thead>
          <tr><th>成员</th><th>角色</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          <tr v-for="m in detail.members" :key="m.userId">
            <td>
              {{ m.name }}
              <span class="on-badge" v-if="m.online">●在线</span>
              <em v-if="m.userId === detail.me?.id" class="me-em">（我）</em>
            </td>
            <td><span class="role-tag" :class="m.role">{{ roleLabel(m.role) }}</span></td>
            <td>
              <span v-if="m.status === 'active'" class="st active">在团</span>
              <span v-else class="st left">已退出</span>
            </td>
            <td class="ops">
              <template v-if="store.canOwner && m.status === 'active' && m.role !== 'owner'">
                <button class="mini" @click="toggleRole(m)">{{ m.role === 'admin' ? '降为成员' : '设为管理员' }}</button>
                <button class="mini danger" @click="doTransfer(m)">转让场主</button>
              </template>
              <template v-if="m.userId === detail.me?.id && m.role !== 'owner'">
                <button class="mini danger" @click="doLeave">退出农场</button>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="perm-note">
        🔐 权限：成员可种植/养护/收获、买卖交易、加工排产、动物养护、育种养护；
        管理员额外可推进时间与灾害结算、建造/拆除防灾与灌溉设施、发起杂交试验、管理邀请；
        场主独占成员角色、转让/解散与建筑升级。
      </div>

      <!-- 邀请码（管理员+） -->
      <div v-if="store.canManage && !store.unclaimed" class="invite-create">
        <div class="row-inline wrap">
          <label>授予角色
            <select v-model="invRole">
              <option value="member">成员</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          <label>可用次数
            <select v-model.number="invUses">
              <option :value="1">1 次</option>
              <option :value="5">5 次</option>
              <option :value="20">20 次</option>
            </select>
          </label>
          <label>有效期
            <select v-model.number="invTtl">
              <option :value="24*3600*1000">1 天</option>
              <option :value="3*24*3600*1000">3 天</option>
              <option :value="7*24*3600*1000">7 天</option>
            </select>
          </label>
          <button class="btn primary" @click="doCreateInvite">生成邀请码</button>
        </div>
        <table class="invites" v-if="detail?.invites?.length">
          <thead><tr><th>邀请码</th><th>角色</th><th>次数</th><th>有效期</th><th>状态</th><th></th></tr></thead>
          <tbody>
            <tr v-for="iv in detail.invites" :key="iv.code">
              <td class="code">{{ iv.code }}</td>
              <td>{{ roleLabel(iv.role) }}</td>
              <td>{{ iv.uses }}/{{ iv.maxUses }}</td>
              <td>{{ fmtExpire(iv) }}</td>
              <td>
                <span v-if="iv.valid" class="st active">有效</span>
                <span v-else-if="iv.revoked" class="st left">已撤销</span>
                <span v-else-if="iv.uses >= iv.maxUses" class="st left">已用完</span>
                <span v-else class="st left">已过期</span>
              </td>
              <td>
                <button class="mini" @click="copyCode(iv.code)">复制</button>
                <button v-if="iv.valid" class="mini danger" @click="doRevoke(iv.code)">撤销</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else-if="store.unclaimed" class="hint">认领农场后即可邀请好友共营。</p>
      <p v-else class="hint">仅管理员/场主可生成与管理邀请码。</p>

      <!-- 危险操作 -->
      <div v-if="store.canOwner && !store.unclaimed" class="danger-zone">
        <button class="btn danger" @click="doDisband" v-if="store.farmId !== 1">解散此农场（删除全部存档）</button>
        <em v-else>初始农场不可解散，可邀请好友共营。</em>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useGameStore } from '@/store/game'
const emit = defineEmits(['close'])
const store = useGameStore()

const name = ref(store.pendingName || store.user?.name || '')
const err = ref('')
async function doRegister() {
  err.value = ''
  if (!name.value.trim()) { err.value = '请输入昵称'; return }
  try {
    await store.register(name.value.trim())
    await bootAfterAuth()
  } catch (e) { err.value = e.message }
}

const showCreate = ref(false)
const showInvite = ref(false)
const newFarmName = ref('')
const createErr = ref('')
const joinCode = ref('')
const joinErr = ref('')
const switchTarget = ref(store.farmId)

// 成员/邀请详情随 SSE 变化与农场切换刷新
const detail = computed(() => store.coopDetail)
async function refreshDetail() {
  if (showInvite.value) await store.loadCoopDetail()
}
watch(() => store.farmId, () => { switchTarget.value = store.farmId; refreshDetail() })
watch(showInvite, (v) => { if (v) store.loadCoopDetail() })

// 登录后：恢复身份 → 自动加载当前农场 → 建立实时通道
async function bootAfterAuth() {
  await store.restoreMe()
  await store.load()
  store.startEvents()
  if (store.canManage) store.loadCoopDetail()
}
onMounted(async () => {
  if (store.token) {
    try {
      await store.restoreMe()
      await store.load()
      store.startEvents()
      if (store.canManage) store.loadCoopDetail()
    } catch (e) {
      if (e.code === 'AUTH') store.logout()
    }
  }
})

async function onSwitch(e) {
  const id = Number(e.target.value)
  if (id === store.farmId) return
  await store.switchFarm(id)
  if (showInvite.value) await store.loadCoopDetail()
}
async function doCreate() {
  createErr.value = ''
  try {
    await store.createFarm(newFarmName.value.trim())
    showCreate.value = false
    newFarmName.value = ''
    store.showToast('新农场已创建', 'success')
  } catch (e) { createErr.value = e.message }
}
async function doJoin() {
  joinErr.value = ''
  if (joinCode.value.trim().length < 6) { joinErr.value = '请输入完整邀请码'; return }
  try {
    const r = await store.joinFarm(joinCode.value.trim())
    store.showToast(r.rejoined ? '已回归农场' : `已加入「${r.farmName}」`, 'success')
    joinCode.value = ''
  } catch (e) { joinErr.value = e.message }
}
async function doClaim() {
  try {
    await store.claimFarm()
    await store.load()
    store.startEvents()
    await store.loadCoopDetail()
    store.showToast('已认领旧单人存档，你现在是场主', 'success')
  } catch (e) { store.showToast(e.message, 'warn') }
}
async function doLeave() {
  if (!confirm('确认退出该农场？退出后将无法操作，需凭新邀请码回归。')) return
  await store.leaveFarm()
  showInvite.value = false
}
async function toggleRole(m) {
  const role = m.role === 'admin' ? 'member' : 'admin'
  try {
    await store.setMemberRole(m.userId, role)
  } catch (e) { store.showToast(e.message, 'warn') }
}
async function doTransfer(m) {
  if (!confirm(`确认把农场转让给「${m.name}」？转让后你将成为管理员。`)) return
  try {
    await store.transferFarm(m.userId)
    store.showToast(`农场已转让给 ${m.name}`, 'success')
  } catch (e) { store.showToast(e.message, 'warn') }
}
async function doDisband() {
  if (!confirm('确认解散此农场？全部存档（金币/作物/建筑/育种等）将永久删除，无法恢复！')) return
  if (!confirm('请再次确认：真的要永久删除整座农场吗？')) return
  try {
    await store.disbandFarm()
    showInvite.value = false
    await store.load().catch(() => {})
  } catch (e) { store.showToast(e.message, 'warn') }
}

// 邀请码创建
const invRole = ref('member')
const invUses = ref(1)
const invTtl = ref(2 * 24 * 3600 * 1000)
async function doCreateInvite() {
  try {
    const iv = await store.createInvite(invRole.value, invUses.value, invTtl.value)
    await store.loadCoopDetail()
    copyCode(iv.code)
    store.showToast('邀请码已生成并复制到剪贴板', 'success')
  } catch (e) { store.showToast(e.message, 'warn') }
}
async function doRevoke(code) {
  try { await store.revokeInvite(code); await store.loadCoopDetail() }
  catch (e) { store.showToast(e.message, 'warn') }
}
async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code)
    store.showToast(`邀请码 ${code} 已复制`, 'info')
  } catch {
    store.showToast(`邀请码：${code}`, 'info')
  }
}
function roleLabel(r) {
  return { owner: '场主', admin: '管理员', member: '成员' }[r] || '访客'
}
function fmtExpire(iv) {
  const left = iv.expiresAt - Date.now()
  if (left <= 0) return '已过期'
  const h = Math.floor(left / 3600000)
  return h >= 24 ? `剩 ${Math.floor(h / 24)} 天` : `剩 ${h} 小时`
}
</script>

<style scoped>
.coop-login { max-width: 520px; margin: 60px auto; padding: 28px; }
.coop-login h2 { margin: 0 0 10px; color: #fff; }
.sub, .hint { color: #8ba2c8; font-size: 12px; line-height: 1.7; }
.old-save { color: #6f84ab; font-size: 11px; margin: 12px 0 0; }
.login-row, .row-inline { display: flex; gap: 8px; }
.login-row input, .row-inline input {
  flex: 1; background: #0c1730; border: 1px solid rgba(120,160,220,0.3); color: #dbe4f3;
  border-radius: 8px; padding: 10px 12px; font-size: 13px;
}
.btn {
  background: #13233f; border: 1px solid rgba(120,160,220,0.3); color: #c6d2e6;
  border-radius: 8px; padding: 8px 14px; font-size: 12px; cursor: pointer; white-space: nowrap;
}
.btn:hover { filter: brightness(1.2); }
.btn.primary { background: linear-gradient(135deg,#43a047,#2e7d32); color: #fff; border: none; font-weight: 600; }
.btn.danger { background: #b71c1c; color: #fff; border: none; }
.err { color: #ef9a9a; font-size: 12px; }

.coop-hub { max-width: 1100px; margin: 0 auto; padding: 12px 20px; }
.hub-bar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  background: #0f1b38; border: 1px solid rgba(120,160,220,0.16); border-radius: 12px;
  padding: 10px 16px; margin-bottom: 12px; flex-wrap: wrap;
}
.me { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #dbe4f3; }
.avatar { font-size: 22px; }
.farm-name { color: #90caf9; margin-left: 6px; }
.role-tag {
  font-size: 10px; padding: 2px 8px; border-radius: 10px; font-weight: 600;
}
.role-tag.owner { background: #4a2c00; color: #ffd54f; border: 1px solid #ffb300; }
.role-tag.admin { background: #0d3a52; color: #4fc3f7; border: 1px solid #29b6f6; }
.role-tag.member { background: #1b2a44; color: #aebadd; border: 1px solid rgba(120,160,220,0.3); }
.online-dot { width: 8px; height: 8px; border-radius: 50%; background: #5b6f94; margin-left: 8px; }
.online-dot.on { background: #66bb6a; box-shadow: 0 0 6px #66bb6a; }
.online-text { font-size: 11px; color: #6f84ab; }
.hub-actions { display: flex; gap: 8px; align-items: center; }
.hub-actions select {
  background: #0c1730; color: #dbe4f3; border: 1px solid rgba(120,160,220,0.3);
  border-radius: 8px; padding: 7px 10px; font-size: 12px;
}
.card {
  background: #0f1b38; border: 1px solid rgba(120,160,220,0.16); border-radius: 12px;
  padding: 16px; margin-bottom: 12px;
}
.card h3 { margin: 0 0 8px; color: #fff; font-size: 14px; }
.row-inline.wrap { flex-wrap: wrap; align-items: center; gap: 10px; }
.row-inline label { font-size: 12px; color: #8ba2c8; display: flex; align-items: center; gap: 6px; }
.row-inline select {
  background: #0c1730; color: #dbe4f3; border: 1px solid rgba(120,160,220,0.3);
  border-radius: 6px; padding: 6px 8px; font-size: 12px;
}
.code-input { text-transform: uppercase; letter-spacing: 3px; font-weight: 700; }

table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 12px; }
th { text-align: left; color: #6f84ab; font-weight: 500; padding: 6px 8px; border-bottom: 1px solid rgba(120,160,220,0.15); }
td { padding: 8px; border-bottom: 1px dashed rgba(120,160,220,0.1); color: #c6d2e6; }
.mini {
  background: #16263f; border: 1px solid rgba(120,160,220,0.25); color: #c6d2e6;
  border-radius: 6px; padding: 4px 9px; font-size: 11px; cursor: pointer; margin-right: 4px;
}
.mini:hover { filter: brightness(1.25); }
.mini.danger { background: #4a1f1f; color: #ef9a9a; border-color: rgba(239,83,80,0.4); }
.on-badge { font-size: 10px; color: #66bb6a; margin-left: 6px; }
.me-em { color: #ffd54f; font-style: normal; font-size: 11px; }
.st.active { color: #a5d6a7; }
.st.left { color: #8ba2c8; }
.ops { white-space: nowrap; }
.perm-note {
  margin-top: 12px; padding: 10px 12px; background: #0c1730; border-radius: 8px;
  color: #6f84ab; font-size: 11px; line-height: 1.7;
}
.invite-create { margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(120,160,220,0.15); }
.invites .code { font-weight: 700; letter-spacing: 2px; color: #ffd54f; }
.claim-row { display: flex; align-items: center; gap: 12px; }
.warn-box {
  background: #3a2c12; border: 1px solid #ffb300; color: #ffe0b2;
  border-radius: 8px; padding: 10px 14px; font-size: 12px;
}
.danger-zone { margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(239,83,80,0.2); }
.danger-zone em { color: #6f84ab; font-size: 11px; }
</style>
