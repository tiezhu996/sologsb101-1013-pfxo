<script setup lang="ts">
/**
 * <BatchListPanel> 本机保留的离线合并批次列表：
 * - failed 批次可原样重试（原批次文件完整保留在批次行里）；
 * - merged 批次可继续处理待选差异；resolved 批次保留结案记录，可删除或导出原始批次；
 * - 放弃批次会移除调查组副本并解除未决标记。
 */
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Download, RefreshRight, Warning } from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useSyncStore } from '@/stores/syncStore'
import type { SyncBatch } from '@/types/sync'
import { BATCH_STATUS_LABELS } from '@/types/sync'
import { sumStats } from '@/utils/merge'
import { DB_NAME } from '@/utils/db'

const props = defineProps<{ activeBatchId?: string | null }>()
const emit = defineEmits<{ (event: 'open', batch: SyncBatch): void; (event: 'changed'): void }>()

const syncStore = useSyncStore()

function statusTagType(status: SyncBatch['status']): 'success' | 'warning' | 'info' | 'danger' {
  if (status === 'resolved') return 'success'
  if (status === 'failed') return 'danger'
  if (status === 'merged') return 'warning'
  return 'info'
}

function openCount(batch: SyncBatch): number {
  return batch.conflicts.filter((item) => !item.resolved).length
}

async function retry(batch: SyncBatch): Promise<void> {
  const result = await syncStore.commit(batch.id)
  if (result.status === 'failed') {
    ElMessage.error(`重试仍失败：${result.lastError}`)
  } else {
    ElMessage.success('合并已完成')
    emit('changed')
    if (result.status === 'merged') emit('open', result)
  }
}

async function discard(batch: SyncBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `放弃批次「${batch.groupName}」？将删除该调查组写入的副本并解除待选标记；已直接接收（仅调查组改过）的主台账行会保留。原始批次记录仍保留在本机。`,
      '放弃合并批次',
      { type: 'warning', confirmButtonText: '放弃并清理副本', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await syncStore.discard(batch.id)
  ElMessage.success('批次已放弃，调查组副本已清理')
  emit('changed')
}

async function remove(batch: SyncBatch): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `从本机删除批次「${batch.groupName}」的存档记录？主台账数据不受影响，但该原始批次文件将无法再恢复。`,
      '删除批次存档',
      { type: 'warning', confirmButtonText: '删除存档', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await syncStore.removeRecord(batch.id)
  ElMessage.success('批次存档已删除')
  emit('changed')
}

function downloadOriginal(batch: SyncBatch): void {
  const payload = {
    ...batch.payload,
    kind: 'group',
    groupName: batch.groupName,
    batchRecover: { batchId: batch.id, status: batch.status, createdAt: new Date(batch.createdAt).toISOString() }
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${DB_NAME}-recover-${batch.id}.json`
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function formatTime(value: number | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}

function statsOf(batch: SyncBatch) {
  return sumStats(batch.stats)
}

function rowClassName({ row }: { row: SyncBatch }): string {
  return row.id === props.activeBatchId ? 'batch-row--active' : ''
}
</script>

<template>
  <el-card shadow="never" class="gb-panel">
    <div class="gb-panel-title">
      <h3>本机保留的合并批次（{{ syncStore.batches.length }}）</h3>
      <span class="gb-hint">原批次文件随批次保留；合并失败或中断后可从这里恢复「已确认内容 + 待选差异」接着处理</span>
    </div>

    <EmptyPanel
      v-if="syncStore.batches.length === 0"
      title="暂无合并批次"
      description="两组上岛调查回到站部后，在此选择各组带回的离线备份并入主台账。"
      compact
    />

    <el-table v-else :data="syncStore.batches" border stripe size="small" class="gb-table-compact" :row-class-name="rowClassName">
      <el-table-column label="调查组 / 批次" min-width="200">
        <template #default="{ row }">
          <div><strong>{{ row.groupName }}</strong></div>
          <div class="gb-hint gb-mono">{{ row.fileName }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusTagType(row.status)" size="small">
            {{ BATCH_STATUS_LABELS[row.status as SyncBatch['status']] }}
          </el-tag>
          <el-icon v-if="row.status === 'failed'" color="#c0392b"><Warning /></el-icon>
        </template>
      </el-table-column>
      <el-table-column label="合并量" min-width="210">
        <template #default="{ row }">
          <span class="gb-mono">
            新增 {{ statsOf(row).added }} · 接收 {{ statsOf(row).accepted }} · 冲突 {{ statsOf(row).conflicts }}
          </span>
          <el-tag v-if="openCount(row) > 0" type="warning" size="small" style="margin-left: 6px">
            {{ openCount(row) }} 条待选
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="暂存 / 合并时间" width="170">
        <template #default="{ row }">
          <div class="gb-hint gb-mono">{{ formatTime(row.createdAt) }}</div>
          <div class="gb-hint gb-mono">{{ formatTime(row.mergedAt) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'staged' || row.status === 'failed'" size="small" type="primary" :icon="RefreshRight" @click="retry(row)">
            {{ row.status === 'failed' ? '重试合并' : '执行合并' }}
          </el-button>
          <el-button v-if="openCount(row) > 0" size="small" type="warning" @click="emit('open', row)">
            处理待选差异
          </el-button>
          <el-button size="small" text @click="emit('open', row)">详情</el-button>
          <el-button size="small" text :icon="Download" @click="downloadOriginal(row)">原批次</el-button>
          <el-button v-if="row.status !== 'resolved'" size="small" text type="danger" @click="discard(row)">放弃</el-button>
          <el-button v-else size="small" text type="danger" :icon="Delete" @click="remove(row)">删存档</el-button>
        </template>
      </el-table-column>
      <template #empty>
        <span v-if="false" />
      </template>
    </el-table>
  </el-card>
</template>

<style scoped>
:deep(.batch-row--active) {
  background: #e8f5f2 !important;
}
</style>
