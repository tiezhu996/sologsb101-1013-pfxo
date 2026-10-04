<script setup lang="ts">
/**
 * <BatchStagingPanel> 离线合并暂存面板：
 * 选择上岛调查组带回的备份 JSON → 校验 → 预览「新增 / 直接接收 / 待选差异」→
 * 先暂存到本机（原批次保留），确认后再执行合并。合并失败可在此原样重试。
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { Connection, RefreshRight, Upload } from '@element-plus/icons-vue'
import { readFileText, validateBackup } from '@/utils/export'
import type { BackupPayload } from '@/utils/db'
import { planMerge, sumStats, TABLE_LABELS, type BusinessTable } from '@/utils/merge'
import { db } from '@/utils/db'
import { useSyncStore } from '@/stores/syncStore'
import type { SyncBatch } from '@/types/sync'

const emit = defineEmits<{ (event: 'staged', batch: SyncBatch): void; (event: 'merged', batch: SyncBatch): void }>()

const syncStore = useSyncStore()
const fileList = ref<UploadFile[]>([])
const groupName = ref('一组')
const parsing = ref(false)
const payload = ref<BackupPayload | null>(null)
const parseError = ref('')
const preview = ref<ReturnType<typeof planMerge> | null>(null)
const merging = ref(false)

const TABLE_ORDER: BusinessTable[] = ['reefs', 'sites', 'belts', 'corals', 'fishes']

async function handleFile(): Promise<void> {
  const file = fileList.value[0]?.raw
  parseError.value = ''
  payload.value = null
  preview.value = null
  if (!file) return
  parsing.value = true
  try {
    const text = await readFileText(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      parseError.value = '文件不是合法的 JSON，无法解析'
      return
    }
    const validation = validateBackup(parsed)
    if (!validation.ok || !validation.payload) {
      parseError.value = `备份校验失败：${validation.errors.join('；')}`
      return
    }
    payload.value = validation.payload
    if (payload.value.kind === 'group' && payload.value.groupName) {
      groupName.value = payload.value.groupName
    }
    await refreshPreview()
  } finally {
    parsing.value = false
  }
}

async function refreshPreview(): Promise<void> {
  if (!payload.value) return
  const local = {
    reefs: await db.reefs.toArray(),
    sites: await db.sites.toArray(),
    belts: await db.belts.toArray(),
    corals: await db.corals.toArray(),
    fishes: await db.fishes.toArray()
  }
  preview.value = planMerge(local, payload.value, 'preview', groupName.value || payload.value.groupName || '上岛调查组')
}

const totals = computed(() => (preview.value ? sumStats(preview.value.stats) : null))

const hasBase = computed(() => payload.value?.base != null)

async function saveAndMerge(): Promise<void> {
  if (!payload.value || !preview.value || !totals.value) {
    ElMessage.warning('请先选择有效的调查组备份文件')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将暂存该批次到本机并执行离线合并：新增 ${totals.value.added} 条、直接接收 ${totals.value.accepted} 条、待选差异 ${totals.value.conflicts} 组。` +
        `待选差异在选定前不进入覆盖度汇总。确认继续？`,
      '离线合并确认',
      { type: 'warning', confirmButtonText: '暂存并合并', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  merging.value = true
  try {
    // 1) 原批次先落本机（即使下一步失败，批次也保留、可重试）
    const batch = await syncStore.stage(payload.value, fileList.value[0]?.name ?? 'group-backup.json', groupName.value)
    // 2) 执行合并（内部单事务；失败标 failed 且五表不动）
    const merged = await syncStore.commit(batch.id)
    if (merged.status === 'failed') {
      ElMessage.error(`合并未完成，原批次已保留在本机：${merged.lastError}；可在批次列表中重试。`)
    } else if (merged.status === 'merged') {
      ElMessage.warning(`合并完成，另有 ${merged.conflicts.filter((item) => !item.resolved).length} 组两边都改过的差异待选定。`)
    } else {
      ElMessage.success('合并完成，无待选差异，数据已进入覆盖度汇总。')
    }
    emit('staged', merged)
    emit('merged', merged)
    resetForm()
  } finally {
    merging.value = false
  }
}

async function stageOnly(): Promise<void> {
  if (!payload.value) {
    ElMessage.warning('请先选择有效的调查组备份文件')
    return
  }
  const batch = await syncStore.stage(
    payload.value,
    fileList.value[0]?.name ?? 'group-backup.json',
    groupName.value
  )
  ElMessage.success('批次已暂存到本机，可稍后在批次列表中执行合并。')
  emit('staged', batch)
  resetForm()
}

function resetForm(): void {
  payload.value = null
  preview.value = null
  parseError.value = ''
  fileList.value = []
}
</script>

<template>
  <el-card shadow="never" class="gb-panel">
    <div class="gb-panel-title">
      <h3>上岛调查组离线备份并入主台账</h3>
      <span class="gb-hint">礁区按名称、站位 / 样带按编号对齐；只在一边改过的直接接收，两边都改的保留两份待选定</span>
    </div>

    <el-form label-width="110px">
      <el-form-item label="调查组来源">
        <el-input v-model="groupName" placeholder="如：一组 / 二组" maxlength="20" style="max-width: 260px" @change="refreshPreview" />
        <span class="gb-hint" style="margin-left: 10px">将作为来源标记写入调查组记录</span>
      </el-form-item>
      <el-form-item label="调查组备份">
        <el-upload
          v-model:file-list="fileList"
          :auto-upload="false"
          :limit="1"
          accept="application/json,.json"
          :on-change="handleFile"
          :on-remove="resetForm"
        >
          <el-button :icon="Upload" :loading="parsing">选择调查组 JSON</el-button>
          <template #tip>
            <div class="gb-hint">支持离站拷贝（带 base 基线，判定最准）或无基线的早期备份（两边不一致时保守列为待选）</div>
          </template>
        </el-upload>
      </el-form-item>
    </el-form>

    <el-alert
      v-if="parseError"
      type="error"
      :title="parseError"
      :closable="false"
      show-icon
      style="margin-bottom: 10px"
    />
    <el-alert
      v-else-if="payload && !hasBase"
      type="info"
      :closable="false"
      show-icon
      title="该备份没有离站基线（base）：无法区分两边修改，凡是两边内容不一致的记录都会保守列为待选差异。"
      style="margin-bottom: 10px"
    />

    <div v-if="preview && totals" class="stage-preview">
      <el-table :data="TABLE_ORDER.map((table) => ({ table, ...(preview?.stats[table] ?? { added: 0, accepted: 0, unchanged: 0, conflicts: 0 }) }))" border size="small" class="gb-table-compact">
        <el-table-column label="数据表" width="130">
          <template #default="{ row }">{{ TABLE_LABELS[row.table as BusinessTable] }}</template>
        </el-table-column>
        <el-table-column prop="added" label="调查组新增" width="110" align="right" />
        <el-table-column prop="accepted" label="直接接收" width="110" align="right" />
        <el-table-column prop="unchanged" label="两边一致" width="110" align="right" />
        <el-table-column label="两边都改 · 待选定" width="150" align="right">
          <template #default="{ row }">
            <el-tag v-if="row.conflicts > 0" type="warning" size="small">{{ row.conflicts }} 组</el-tag>
            <span v-else class="gb-hint">0</span>
          </template>
        </el-table-column>
      </el-table>
      <p class="gb-hint">
        合计：新增 {{ totals.added }} · 直接接收 {{ totals.accepted }} · 两边一致 {{ totals.unchanged }} · 待选差异
        <strong :class="totals.conflicts > 0 ? 'stage-preview__warn' : ''">{{ totals.conflicts }}</strong>
      </p>
      <div class="stage-preview__actions">
        <el-button :icon="Connection" type="primary" :loading="merging" @click="saveAndMerge">暂存到本机并执行合并</el-button>
        <el-button :icon="RefreshRight" :loading="syncStore.busy" @click="stageOnly">只暂存，稍后处理</el-button>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.stage-preview {
  margin-top: 6px;
}

.stage-preview__actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.stage-preview__warn {
  color: #b56a12;
}
</style>
