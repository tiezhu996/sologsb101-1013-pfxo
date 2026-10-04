<script setup lang="ts">
/**
 * 模块 7：/sync 离线合并中心
 * 两组上岛调查回站部后，在此把各组离线备份并入主台账：
 * 礁区/站位/样带按名称与编号对齐 → 一边改过直接接收 → 两边都改保留两份待选定；
 * 未选定前不进入覆盖度汇总；原批次留在本机，失败 / 中断可恢复接着处理。
 * 复用 <ConflictReviewPanel>、<BatchStagingPanel>、<BatchListPanel>、<StatBadge>。
 */
import { computed, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Connection, Files, Warning } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import BatchStagingPanel from '@/components/sync/BatchStagingPanel.vue'
import BatchListPanel from '@/components/sync/BatchListPanel.vue'
import ConflictReviewPanel from '@/components/sync/ConflictReviewPanel.vue'
import { useSyncStore } from '@/stores/syncStore'
import { useSurveyStore } from '@/stores/surveyStore'
import { initDatabase } from '@/utils/db'
import type { SyncBatch } from '@/types/sync'

const syncStore = useSyncStore()
const surveyStore = useSurveyStore()

const selectedBatchId = ref<string | null>(null)

const selectedBatch = computed<SyncBatch | null>(() => syncStore.batchById(selectedBatchId.value))

const openConflictCount = computed(() => syncStore.openConflictCount)
const pendingRowCount = computed(() => {
  const pending = (rows: Array<{ pending?: boolean }>) => rows.filter((row) => row.pending === true).length
  return (
    pending(surveyStore.reefs) +
    pending(surveyStore.sites) +
    pending(surveyStore.belts) +
    pending(surveyStore.corals) +
    pending(surveyStore.fishes)
  )
})

function openBatch(batch: SyncBatch): void {
  selectedBatchId.value = batch.id
}

async function handleChanged(): Promise<void> {
  await syncStore.refresh()
}

function notifyMerged(batch: SyncBatch): void {
  if (batch.status === 'merged') {
    selectedBatchId.value = batch.id
  }
}

onMounted(async () => {
  await initDatabase()
  syncStore.start()
  await syncStore.refresh()
  const firstOpen = syncStore.actionableBatches[0]
  if (firstOpen && (firstOpen.status === 'merged' || firstOpen.status === 'failed')) {
    selectedBatchId.value = firstOpen.id
  }
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">离线调查合并中心</h2>
        <p class="gb-hint">
          两组分别上岛离线调查，回站部后在此并入主台账。礁区按名称、站位与样带按编号对齐；
          一边改过的底质、珊瑚记录或鱼类计数直接接收，两边都改过的保留两份并标注来源，选定前不进入覆盖度汇总。
        </p>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="本机批次" :value="syncStore.batches.length" suffix="个" icon="Files" />
      <StatBadge
        label="待选差异"
        :value="openConflictCount"
        suffix="组"
        :tone="openConflictCount > 0 ? 'warning' : 'success'"
        :icon="openConflictCount > 0 ? 'WarningFilled' : 'CircleCheckFilled'"
      />
      <StatBadge
        label="未决记录行"
        :value="pendingRowCount"
        suffix="行"
        tone="info"
        icon="Warning"
      />
      <StatBadge
        label="失败 / 待合并"
        :value="syncStore.batches.filter((batch) => batch.status === 'failed' || batch.status === 'staged').length"
        suffix="个"
        :tone="syncStore.batches.some((batch) => batch.status === 'failed') ? 'warning' : 'success'"
        icon="Connection"
      />
    </div>

    <el-alert
      v-if="pendingRowCount > 0"
      type="warning"
      show-icon
      :closable="false"
      :title="`当前有 ${pendingRowCount} 行两边都改过的待选记录（含来源标记）。它们尚未进入覆盖度汇总，请在下方逐条或批量选定。`"
    />

    <BatchStagingPanel @staged="openBatch" @merged="notifyMerged" />

    <BatchListPanel :active-batch-id="selectedBatchId" @open="openBatch" @changed="handleChanged" />

    <template v-if="selectedBatch">
      <el-card shadow="never" class="gb-panel">
        <div class="gb-panel-title">
          <h3>批次详情 · {{ selectedBatch.groupName }}</h3>
          <div>
            <el-button size="small" text @click="selectedBatchId = null">收起详情</el-button>
          </div>
        </div>
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="批次号">{{ selectedBatch.id }}</el-descriptions-item>
          <el-descriptions-item label="原始文件">{{ selectedBatch.fileName }}</el-descriptions-item>
          <el-descriptions-item label="调查组来源">{{ selectedBatch.groupName }}</el-descriptions-item>
          <el-descriptions-item label="暂存时间">{{ new Date(selectedBatch.createdAt).toLocaleString('zh-CN') }}</el-descriptions-item>
          <el-descriptions-item label="合并时间">
            {{ selectedBatch.mergedAt ? new Date(selectedBatch.mergedAt).toLocaleString('zh-CN') : '尚未合并' }}
          </el-descriptions-item>
          <el-descriptions-item label="离站基线">{{ selectedBatch.base ? '已携带（三方判定）' : '未携带（保守判定）' }}</el-descriptions-item>
        </el-descriptions>
        <el-alert
          v-if="selectedBatch.status === 'failed'"
          type="error"
          show-icon
          :closable="false"
          style="margin-top: 10px"
          :title="`上次合并失败，主台账未被改动，原批次已保留：${selectedBatch.lastError || '未知错误'}。可在批次列表点击「重试合并」。`"
        />
      </el-card>

      <ConflictReviewPanel :key="selectedBatch.id" :batch="selectedBatch" @changed="handleChanged" />
    </template>

    <p class="gb-hint" style="text-align: center">
      合并与选定全程离线完成，数据只保存在本站浏览器 IndexedDB；导出备份时会同时携带批次、记录来源与未决状态。
    </p>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}
</style>
