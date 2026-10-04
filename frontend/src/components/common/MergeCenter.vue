<script setup lang="ts">
/**
 * <MergeCenter> 站部离线合并中心（抽屉）。
 * - 选择离线组备份 → 预览「直接接收 / 待决 / 跳过」→ 执行合并；
 * - 合并失败时原批次留在本机，可重试或放弃，已确认内容与待决差异保留；
 * - 待决差异逐条三选一（保留站部 / 接收离线组 / 两份都留），也可整批统一选择；
 * - 选定前待决记录不进入覆盖度汇总。
 */
import { computed, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { RefreshRight, Delete, DocumentChecked, WarningFilled } from '@element-plus/icons-vue'
import { useMergeStore } from '@/stores/mergeStore'
import SourceTag from '@/components/common/SourceTag.vue'
import { ENTITY_FIELDS } from '@/utils/merge'
import type { MergeEntityName } from '@/types/merge'
import { validateBackup, readFileText, type BackupKey } from '@/utils/export'
import type { BackupPayload } from '@/utils/db'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
  (e: 'merged'): void
}>()

const mergeStore = useMergeStore()

const visible = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value)
})

const ENTITY_LABELS: Record<MergeEntityName, string> = {
  reefs: '礁区',
  sites: '站位',
  belts: '样带',
  corals: '珊瑚记录',
  fishes: '鱼类计数'
}
const ENTITY_ORDER: BackupKey[] = ['reefs', 'sites', 'belts', 'corals', 'fishes']

const sourceInput = ref('甲组')
const file = ref<File | null>(null)
const parsedPayload = ref<BackupPayload | null>(null)
const preview = ref<Awaited<ReturnType<typeof mergeStore.previewMerge>> | null>(null)
const previewError = ref('')
const running = ref(false)

const activeTab = ref('import')

const drawerTitle = computed(() => '离线合并中心')

function resetPreview(): void {
  file.value = null
  parsedPayload.value = null
  preview.value = null
  previewError.value = ''
}

async function handleFileChange(uploadFile: { raw?: File }): Promise<void> {
  previewError.value = ''
  preview.value = null
  parsedPayload.value = null
  if (!uploadFile?.raw) return
  const selected = uploadFile.raw
  file.value = selected
  try {
    const text = await readFileText(selected)
    const parsed = JSON.parse(text) as unknown
    const validation = validateBackup(parsed)
    if (!validation.ok || !validation.payload) {
      previewError.value = `备份校验失败：${validation.errors.join('；')}`
      return
    }
    parsedPayload.value = validation.payload
    if (!sourceInput.value.trim()) sourceInput.value = validation.payload.source
    await loadPreview()
  } catch {
    previewError.value = '文件不是合法的 JSON，无法解析'
  }
}

async function loadPreview(): Promise<void> {
  if (!parsedPayload.value) return
  const source = sourceInput.value.trim() || '离线组'
  preview.value = await mergeStore.previewMerge(parsedPayload.value, source)
}

const previewTotals = computed(() => {
  if (!preview.value) return { accepted: 0, conflicts: 0, identical: 0 }
  return ENTITY_ORDER.reduce(
    (sum, key) => ({
      accepted: sum.accepted + preview.value!.stats[key].accepted,
      conflicts: sum.conflicts + preview.value!.stats[key].conflicts,
      identical: sum.identical + preview.value!.stats[key].identical
    }),
    { accepted: 0, conflicts: 0, identical: 0 }
  )
})

async function runMerge(): Promise<void> {
  if (!parsedPayload.value) {
    ElMessage.warning('请先选择离线组备份 JSON 文件')
    return
  }
  const source = sourceInput.value.trim()
  if (!source) {
    ElMessage.warning('请填写离线来源（如：甲组 / 乙组）')
    return
  }
  try {
    await ElMessageBox.confirm(
      `将合并来源「${source}」的备份：直接接收 ${previewTotals.value.accepted} 条一边改动，` +
        `${previewTotals.value.conflicts} 条两边都改的记录将保留两份并进入待决（选定前不进入覆盖度汇总）。确认继续？`,
      '离线合并确认',
      { type: 'warning', confirmButtonText: '开始合并', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  running.value = true
  try {
    const batch = await mergeStore.runMerge(parsedPayload.value, source, file.value?.name ?? '离线备份.json')
    if (batch.status === 'failed') {
      ElMessage.error(`合并中断，批次 ${batch.no} 已留在本机，可在「批次与恢复」中重试：${batch.error}`)
    } else if (batch.status === 'pending') {
      ElMessage.warning(`已接收无争议内容，另有 ${batch.totalConflicts} 条待决差异请逐条选定`)
    } else {
      ElMessage.success(`批次 ${batch.no} 合并完成，无待决差异`)
    }
    resetPreview()
    activeTab.value = 'batches'
    emit('merged')
  } finally {
    running.value = false
  }
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

function rowOf(record: Record<string, unknown> | null, field: string): unknown {
  return record && field in record ? record[field] : null
}

async function choose(conflictId: string, resolution: 'local' | 'incoming' | 'both'): Promise<void> {
  const labels = { local: '保留站部一份', incoming: '接收离线组一份', both: '两份都保留' } as const
  try {
    await ElMessageBox.confirm(
      `确认对该条差异执行「${labels[resolution]}」？${
        resolution !== 'both' ? '另一份将被删除。' : '两份均进入覆盖度汇总。'
      }`,
      '待决差异选定',
      { type: 'info', confirmButtonText: '确认选定', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await mergeStore.resolveConflict(conflictId, resolution)
  ElMessage.success('已按选择更新台账与基线')
  emit('merged')
}

async function batchResolve(batchId: string, resolution: 'local' | 'incoming' | 'both'): Promise<void> {
  const list = mergeStore.conflictsOfBatch(batchId).filter((item) => item.status === 'pending')
  if (list.length === 0) return
  const labels = { local: '全部保留站部', incoming: '全部接收离线组', both: '全部两份保留' } as const
  try {
    await ElMessageBox.confirm(`将把该批次 ${list.length} 条待决差异统一「${labels[resolution]}」，确认继续？`, '批量选定', {
      type: 'warning',
      confirmButtonText: '统一选定',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  const count = await mergeStore.resolveBatch(batchId, resolution)
  ElMessage.success(`已处理 ${count} 条待决差异`)
  emit('merged')
}

async function retry(batchId: string): Promise<void> {
  running.value = true
  try {
    const batch = await mergeStore.retryBatch(batchId)
    if (!batch) return
    ElMessage[batch.status === 'failed' ? 'error' : batch.status === 'pending' ? 'warning' : 'success'](
      batch.status === 'failed'
        ? `重试仍失败：${batch.error}`
        : batch.status === 'pending'
          ? `已恢复处理，仍有 ${batch.totalConflicts} 条待决`
          : '重试成功，批次已结案'
    )
    emit('merged')
  } finally {
    running.value = false
  }
}

async function close(batchId: string): Promise<void> {
  try {
    await mergeStore.closeBatch(batchId)
    ElMessage.success('批次已结案')
    emit('merged')
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '无法结案')
  }
}

async function discard(batchId: string): Promise<void> {
  const batch = mergeStore.batches.find((item) => item.id === batchId)
  try {
    await ElMessageBox.confirm(
      `放弃失败批次 ${batch?.no ?? ''}？已接收内容会作为正式台账保留，仅删除该批次记录。`,
      '放弃失败批次',
      { type: 'warning', confirmButtonText: '放弃批次', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await mergeStore.discardBatch(batchId)
    ElMessage.success('失败批次已删除')
  } catch (err) {
    ElMessage.warning(err instanceof Error ? err.message : '无法放弃该批次')
  }
}

function batchTagType(status: string): 'info' | 'warning' | 'success' | 'danger' {
  if (status === 'failed') return 'danger'
  if (status === 'pending') return 'warning'
  if (status === 'resolved') return 'success'
  return 'info'
}

function batchStatusLabel(status: string): string {
  return { processing: '处理中', pending: '有待决', resolved: '已结案', failed: '失败可恢复' }[status] ?? status
}

const fieldLabelMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  ENTITY_ORDER.forEach((entity) => {
    ENTITY_FIELDS[entity].forEach(({ field, label }) => {
      map[`${entity}.${field}`] = label
    })
  })
  return map
})
</script>

<template>
  <el-drawer v-model="visible" :title="drawerTitle" size="72%" :destroy-on-close="false">
    <el-tabs v-model="activeTab" class="merge-tabs">
      <!-- ------------------------------ 导入合并 ------------------------------ -->
      <el-tab-pane name="import">
        <template #label>
          <span>导入离线备份</span>
        </template>

        <el-alert
          type="info"
          :closable="false"
          show-icon
          title="两组普查员分头上岛，回到站部后在此把各组离线备份并入主台账。礁区按名称、站位与样带按编号对齐；一边改过直接接收，两边都改过保留两份、标记来源待选定，选定前不进入覆盖度汇总。"
          class="merge-hint"
        />

        <el-form label-width="110px" class="merge-form">
          <el-form-item label="离线来源" required>
            <el-input v-model="sourceInput" placeholder="如：甲组 / 乙组" maxlength="20" style="max-width: 280px" @change="loadPreview" />
            <span class="merge-caption">合并后这批记录会标上该来源</span>
          </el-form-item>
          <el-form-item label="备份文件">
            <el-upload
              :auto-upload="false"
              :show-file-list="false"
              accept="application/json"
              :on-change="handleFileChange"
            >
              <el-button>选择组内导出的 JSON</el-button>
            </el-upload>
            <span v-if="file" class="merge-file">{{ file.name }}</span>
          </el-form-item>
        </el-form>

        <el-alert v-if="previewError" type="error" :title="previewError" :closable="false" show-icon class="merge-hint" />

        <template v-if="preview">
          <div class="merge-stat-row">
            <div class="merge-stat is-accepted">
              <strong>{{ previewTotals.accepted }}</strong>
              <span>直接接收（一边改动）</span>
            </div>
            <div class="merge-stat is-conflict">
              <strong>{{ previewTotals.conflicts }}</strong>
              <span>待决差异（两边都改）</span>
            </div>
            <div class="merge-stat is-identical">
              <strong>{{ previewTotals.identical }}</strong>
              <span>无变化跳过</span>
            </div>
          </div>

          <el-table :data="ENTITY_ORDER.map((key) => ({ entity: key, ...(preview?.stats[key] ?? { accepted: 0, conflicts: 0, identical: 0 }) }))" border size="small" class="merge-table">
            <el-table-column label="数据表" width="140">
              <template #default="{ row }">{{ ENTITY_LABELS[row.entity as MergeEntityName] }}</template>
            </el-table-column>
            <el-table-column prop="accepted" label="直接接收" width="120" align="right" />
            <el-table-column prop="conflicts" label="待决差异" width="120" align="right" />
            <el-table-column prop="identical" label="无变化" width="120" align="right" />
          </el-table>

          <el-alert
            v-if="preview.baseMissing > 0"
            type="warning"
            :closable="false"
            show-icon
            :title="`有 ${preview.baseMissing} 条记录缺少派发基线（可能是旧版备份），已按「两边取值不同即保留两份待选定」的保守方式处理。`"
            class="merge-hint"
          />
          <el-alert
            v-if="preview.orphans.length > 0"
            type="warning"
            :closable="false"
            show-icon
            class="merge-hint"
            :title="`${preview.orphans.length} 条记录因父级缺失或父级仍待选定而暂缓并入，待父级选定后重新导入该备份即可补齐。`"
          />

          <el-table v-if="preview.conflicts.length > 0" :data="preview.conflicts" border size="small" max-height="280" class="merge-table">
            <el-table-column label="位置 / 对齐键" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">
                <div>{{ row.path }}</div>
                <span class="merge-caption">{{ ENTITY_LABELS[row.entity as MergeEntityName] }}</span>
              </template>
            </el-table-column>
            <el-table-column label="差异字段" min-width="220">
              <template #default="{ row }">
                <el-tag
                  v-for="diff in row.diffs"
                  :key="diff.field"
                  size="small"
                  type="warning"
                  effect="plain"
                  class="merge-diff-tag"
                >
                  {{ fieldLabelMap[`${row.entity}.${diff.field}`] ?? diff.field }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>

          <div class="merge-actions">
            <el-button type="primary" :loading="running" :icon="DocumentChecked" @click="runMerge">执行离线合并</el-button>
            <el-button :icon="RefreshRight" @click="loadPreview">重新预览</el-button>
          </div>
        </template>
      </el-tab-pane>

      <!-- ---------------------------- 批次与待决 ---------------------------- -->
      <el-tab-pane name="batches">
        <template #label>
          <span>批次与待决差异</span>
          <el-badge v-if="mergeStore.pendingCount > 0" :value="mergeStore.pendingCount" class="merge-badge" />
        </template>

        <el-empty v-if="mergeStore.batches.length === 0" description="还没有合并过离线备份" />

        <div v-for="batch in mergeStore.batches" :key="batch.id" class="batch-card">
          <div class="batch-card__head">
            <div>
              <strong>批次 {{ batch.no }}</strong>
              <el-tag :type="batchTagType(batch.status)" size="small" effect="dark" class="batch-card__tag">
                {{ batchStatusLabel(batch.status) }}
              </el-tag>
              <SourceTag :source="batch.source" merge-status="confirmed" show-confirmed-source />
            </div>
            <span class="merge-caption">{{ batch.fileName }} · {{ new Date(batch.createdAt).toLocaleString('zh-CN') }}</span>
          </div>

          <el-alert
            v-if="batch.status === 'failed'"
            type="error"
            :closable="false"
            show-icon
            :title="`合并中断：${batch.error || '未知错误'}。原批次已留在本机，已接收内容与待决差异可恢复后接着处理。`"
            class="merge-hint"
          />

          <div class="batch-card__stats">
            <span v-for="entity in ENTITY_ORDER" :key="entity" class="batch-stat">
              {{ ENTITY_LABELS[entity] }}
              <em>{{ batch.stats[entity].accepted }}</em> 接收 /
              <em>{{ batch.stats[entity].conflicts }}</em> 待决 /
              <em>{{ batch.stats[entity].identical }}</em> 跳过
            </span>
          </div>

          <div v-if="batch.status === 'failed'" class="merge-actions">
            <el-button size="small" type="primary" :icon="RefreshRight" :loading="running" @click="retry(batch.id)">
              恢复并重试
            </el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="discard(batch.id)">放弃失败批次</el-button>
          </div>

          <el-alert
            v-else-if="batch.status === 'pending' && batch.totalConflicts === 0 && batch.error"
            type="warning"
            :closable="false"
            show-icon
            :title="batch.error"
            class="merge-hint"
          >
            <template #default>
              <div class="merge-actions">
                <el-button size="small" type="success" plain @click="close(batch.id)">确认结案（暂缓记录补齐后重新导入）</el-button>
              </div>
            </template>
          </el-alert>

          <template
            v-if="mergeStore.conflictsOfBatch(batch.id).length > 0 && batch.status !== 'failed'"
          >
            <div class="batch-card__resolve">
              <el-button-group>
                <el-button size="small" @click="batchResolve(batch.id, 'local')">全部保留站部</el-button>
                <el-button size="small" @click="batchResolve(batch.id, 'incoming')">全部接收离线组</el-button>
                <el-button size="small" @click="batchResolve(batch.id, 'both')">全部两份保留</el-button>
              </el-button-group>
              <span class="merge-caption">
                已选定 {{ batch.resolvedConflicts }} / {{ batch.totalConflicts }}
              </span>
            </div>

            <div
              v-for="conflict in mergeStore.conflictsOfBatch(batch.id)"
              :key="conflict.id"
              class="conflict-card"
              :class="{ 'is-resolved': conflict.status === 'confirmed' }"
            >
              <div class="conflict-card__head">
                <WarningFilled v-if="conflict.status === 'pending'" class="conflict-card__icon" />
                <strong>{{ conflict.path }}</strong>
                <el-tag size="small" type="info" effect="plain">{{ ENTITY_LABELS[conflict.entity] }}</el-tag>
                <el-tag v-if="conflict.status === 'pending'" size="small" type="warning">待选定</el-tag>
                <el-tag v-else size="small" type="success">
                  已选定·{{ conflict.resolution === 'local' ? '站部' : conflict.resolution === 'incoming' ? '离线组' : '两份保留' }}
                </el-tag>
              </div>

              <el-table :data="conflict.diffs" border size="small" class="conflict-table">
                <el-table-column label="字段" width="130">
                  <template #default="{ row }">
                    {{ fieldLabelMap[`${conflict.entity}.${row.field}`] ?? row.label }}
                  </template>
                </el-table-column>
                <el-table-column v-if="conflict.baseRecord" label="派发基线" width="150">
                  <template #default="{ row }">{{ formatValue(rowOf(conflict.baseRecord, row.field)) }}</template>
                </el-table-column>
                <el-table-column label="站部主台账" min-width="150">
                  <template #default="{ row }">
                    <span :class="{ 'is-diff': row.local !== row.incoming }">{{ formatValue(row.local) }}</span>
                  </template>
                </el-table-column>
                <el-table-column :label="`离线组（${batch.source}）`" min-width="150">
                  <template #default="{ row }">
                    <span :class="{ 'is-diff': row.local !== row.incoming }">{{ formatValue(row.incoming) }}</span>
                  </template>
                </el-table-column>
              </el-table>

              <div v-if="conflict.status === 'pending'" class="conflict-card__actions">
                <el-button size="small" @click="choose(conflict.id, 'local')">保留站部</el-button>
                <el-button size="small" type="primary" @click="choose(conflict.id, 'incoming')">接收离线组</el-button>
                <el-button size="small" type="warning" plain @click="choose(conflict.id, 'both')">两份都保留</el-button>
              </div>
            </div>
          </template>
        </div>
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<style scoped>
.merge-hint {
  margin-bottom: 12px;
}

.merge-form {
  margin-top: 12px;
}

.merge-caption {
  margin-left: 8px;
  font-size: 12px;
  color: #7c9995;
}

.merge-file {
  margin-left: 12px;
  font-size: 13px;
  color: #0b5d5a;
}

.merge-stat-row {
  display: flex;
  gap: 12px;
  margin: 12px 0;
}

.merge-stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  border-radius: 10px;
  border: 1px solid #cfe3e0;
  background: #fff;
}

.merge-stat strong {
  font-size: 26px;
}

.merge-stat span {
  font-size: 13px;
  color: #4c6663;
}

.merge-stat.is-accepted {
  border-left: 4px solid #1e8449;
}

.merge-stat.is-conflict {
  border-left: 4px solid #d68910;
}

.merge-stat.is-identical {
  border-left: 4px solid #7c9995;
}

.merge-table {
  margin-bottom: 12px;
}

.merge-diff-tag {
  margin: 2px 4px 2px 0;
}

.merge-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.merge-badge {
  margin-left: 4px;
}

.batch-card {
  border: 1px solid #cfe3e0;
  border-radius: 10px;
  padding: 14px;
  margin-bottom: 14px;
  background: #fff;
}

.batch-card__head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
}

.batch-card__tag {
  margin: 0 8px;
}

.batch-card__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 10px 0;
  font-size: 13px;
  color: #4c6663;
}

.batch-stat em {
  font-style: normal;
  color: #0b5d5a;
  font-weight: 700;
  margin: 0 2px;
}

.batch-card__resolve {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0;
}

.conflict-card {
  border: 1px dashed #d68910;
  border-radius: 8px;
  padding: 10px;
  margin-top: 10px;
  background: #fffdf7;
}

.conflict-card.is-resolved {
  border-color: #cfe3e0;
  background: #f6fbf9;
  opacity: 0.85;
}

.conflict-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.conflict-card__icon {
  color: #d68910;
}

.conflict-card__actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.conflict-table .is-diff {
  font-weight: 700;
  color: #b95c00;
}
</style>
