/**
 * 离线合并 store：订阅本机保留的合并批次与未决冲突数，
 * 提供暂存 / 预览 / 提交 / 选定 / 放弃等动作的响应式封装（具体逻辑在 utils/syncService）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, watchTable } from '@/utils/db'
import type { BackupPayload } from '@/utils/db'
import type { SyncBatch } from '@/types/sync'
import {
  buildConflictViews,
  commitMerge,
  deleteBatchRecord,
  discardBatch,
  listBatches,
  previewMerge,
  stageBatch,
  resolveAllConflicts,
  resolveConflict,
  type ConflictViewRow
} from '@/utils/syncService'
import type { MergePlan } from '@/utils/merge'
import { sumStats } from '@/utils/merge'

export const useSyncStore = defineStore('sync', () => {
  const batches = ref<SyncBatch[]>([])
  const ready = ref(false)
  const busy = ref(false)
  const lastError = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<SyncBatch>(() => db.syncBatches).subscribe((rows) => {
      batches.value = rows.sort((a, b) => b.createdAt - a.createdAt)
      ready.value = true
      lastError.value = null
    })
  }

  /** 待合并 / 合并失败、可继续处理的批次 */
  const actionableBatches = computed(() =>
    batches.value.filter((batch) => batch.status === 'staged' || batch.status === 'merged' || batch.status === 'failed')
  )

  /** 未决冲突总数 */
  const openConflictCount = computed(() =>
    batches.value.reduce(
      (sum, batch) => sum + (batch.status === 'merged' || batch.status === 'failed'
        ? batch.conflicts.filter((item) => !item.resolved).length
        : 0),
      0
    )
  )

  function batchById(id: string | null | undefined): SyncBatch | null {
    if (!id) return null
    return batches.value.find((batch) => batch.id === id) ?? null
  }

  async function refresh(): Promise<void> {
    batches.value = await listBatches()
  }

  async function stage(payload: BackupPayload, fileName: string, groupName: string): Promise<SyncBatch> {
    busy.value = true
    try {
      const batch = await stageBatch({ payload, fileName, groupName })
      await refresh()
      return batch
    } finally {
      busy.value = false
    }
  }

  async function preview(batch: SyncBatch): Promise<{ plan: MergePlan; totals: ReturnType<typeof sumStats> }> {
    return previewMerge(batch)
  }

  async function commit(batchId: string): Promise<SyncBatch> {
    busy.value = true
    lastError.value = null
    try {
      const result = await commitMerge(batchId)
      if (result.status === 'failed') lastError.value = result.lastError
      await refresh()
      return result
    } finally {
      busy.value = false
    }
  }

  async function conflictViews(batch: SyncBatch): Promise<ConflictViewRow[]> {
    return buildConflictViews(batch)
  }

  async function resolve(batchId: string, conflictId: string, winner: 'local' | 'incoming'): Promise<SyncBatch> {
    busy.value = true
    try {
      const result = await resolveConflict(batchId, conflictId, winner)
      await refresh()
      return result
    } finally {
      busy.value = false
    }
  }

  async function resolveAll(batchId: string, winner: 'local' | 'incoming'): Promise<SyncBatch> {
    busy.value = true
    try {
      const result = await resolveAllConflicts(batchId, winner)
      await refresh()
      return result
    } finally {
      busy.value = false
    }
  }

  async function discard(batchId: string): Promise<void> {
    busy.value = true
    try {
      await discardBatch(batchId)
      await refresh()
    } finally {
      busy.value = false
    }
  }

  async function removeRecord(batchId: string): Promise<void> {
    await deleteBatchRecord(batchId)
    await refresh()
  }

  return {
    batches,
    ready,
    busy,
    lastError,
    actionableBatches,
    openConflictCount,
    start,
    refresh,
    batchById,
    stage,
    preview,
    commit,
    conflictViews,
    resolve,
    resolveAll,
    discard,
    removeRecord
  }
})
