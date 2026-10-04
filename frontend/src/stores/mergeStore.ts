/**
 * 离线合并 store：维护合并批次、待决差异与派发基线，驱动站部合并中心。
 *
 * 失败恢复：批次头先单独落库（processing），随后在一个事务里接收内容、登记待决；
 * 任何一步失败都把批次标 failed 并保留已接收内容与已登记差异，稍后可重试或放弃。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId } from '@/utils/db'
import { watchTable } from '@/utils/db'
import type { MergeBatch, MergeConflict, MergeBase, MergeEntityName } from '@/types/merge'
import type { BackupPayload } from '@/utils/db'
import {
  baseFromRow,
  buildMergePlan,
  contextFrom,
  nextBatchNo,
  normalizeProvenance,
  type Ctx
} from '@/utils/merge'

type BusinessTables = Pick<BackupPayload, 'reefs' | 'sites' | 'belts' | 'corals' | 'fishes'>

const ENTITY_TABLE: Record<MergeEntityName, 'reefs' | 'sites' | 'belts' | 'corals' | 'fishes'> = {
  reefs: 'reefs',
  sites: 'sites',
  belts: 'belts',
  corals: 'corals',
  fishes: 'fishes'
}

const emptyEntityStats = () => ({
  reefs: { accepted: 0, conflicts: 0, identical: 0 },
  sites: { accepted: 0, conflicts: 0, identical: 0 },
  belts: { accepted: 0, conflicts: 0, identical: 0 },
  corals: { accepted: 0, conflicts: 0, identical: 0 },
  fishes: { accepted: 0, conflicts: 0, identical: 0 }
})

async function readLocalTables(): Promise<BusinessTables> {
  const [reefs, sites, belts, corals, fishes] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray()
  ])
  return { reefs, sites, belts, corals, fishes }
}

export const useMergeStore = defineStore('merge', () => {
  const batches = ref<MergeBatch[]>([])
  const conflicts = ref<MergeConflict[]>([])
  const bases = ref<MergeBase[]>([])
  const busy = ref(false)
  const error = ref<string | null>(null)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<MergeBatch>(() => db.mergeBatches).subscribe((rows) => {
      batches.value = rows.sort((a, b) => b.createdAt - a.createdAt)
    })
    watchTable<MergeConflict>(() => db.mergeConflicts).subscribe((rows) => {
      conflicts.value = rows.sort((a, b) => a.createdAt - b.createdAt)
    })
    watchTable<MergeBase>(() => db.mergeBases).subscribe((rows) => {
      bases.value = rows
    })
  }

  /** 全部未决差异 */
  const pendingConflicts = computed(() => conflicts.value.filter((item) => item.status === 'pending'))

  const pendingCount = computed(() => pendingConflicts.value.length)

  /** 待恢复（失败）的批次 */
  const failedBatches = computed(() => batches.value.filter((item) => item.status === 'failed'))

  /** 未完成批次（含待决 / 失败） */
  const openBatches = computed(() =>
    batches.value.filter((item) => item.status === 'pending' || item.status === 'failed' || item.status === 'processing')
  )

  function conflictsOfBatch(batchId: string): MergeConflict[] {
    return conflicts.value
      .filter((item) => item.batchId === batchId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * 预检：只计算计划不落库，供导入前预览「直接接收 / 待决」数量。
   */
  async function previewMerge(
    payload: BackupPayload,
    source: string
  ): Promise<ReturnType<typeof buildMergePlan>> {
    const local = await readLocalTables()
    const normalized = normalizeProvenance(payload, source)
    return buildMergePlan(normalized, local, bases.value, { batchId: 'preview', source })
  }

  /**
   * 执行离线合并。
   * 步骤 1：批次头单独事务落库（即使后续失败，原批次也留在本机可恢复）；
   * 步骤 2：单事务接收可直接合并的内容、登记待决差异、写入基线。
   */
  async function runMerge(payload: BackupPayload, source: string, fileName: string): Promise<MergeBatch> {
    busy.value = true
    error.value = null
    const batchId = createId('mrb')
    const now = Date.now()
    const batch: MergeBatch = {
      id: batchId,
      no: nextBatchNo(batches.value.length),
      source,
      fileName,
      status: 'processing',
      payload: payload as unknown,
      stats: emptyEntityStats(),
      totalConflicts: 0,
      resolvedConflicts: 0,
      error: '',
      createdAt: now,
      updatedAt: now,
      appliedAt: null,
      resolvedAt: null
    }
    // 先保证批次头存活
    await db.mergeBatches.put(batch)

    try {
      const local = await readLocalTables()
      const normalized = normalizeProvenance(payload, source)
      const plan = buildMergePlan(normalized, local, bases.value, { batchId, source })

      await db.transaction(
        'rw',
        [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.mergeConflicts, db.mergeBases, db.mergeBatches],
        async () => {
          // 接收 / 更新本地行；待决时本地一份转 pending
          for (const item of plan.items) {
            const table = db[ENTITY_TABLE[item.entity]]
            if (item.localRow) {
              await table.put(item.localRow as never)
            }
            if (item.incomingRow) {
              await table.put(item.incomingRow as never)
            }
          }

          // 登记待决差异并回填两边记录的 conflictId
          const newConflicts: MergeConflict[] = plan.conflicts.map((entry, index) => {
            const conflictId = createId('mrc')
            const localRecord = (entry.localRecord ?? {}) as Record<string, unknown>
            const incomingRecord = (entry.incomingRecord ?? {}) as Record<string, unknown>
            localRecord.conflictId = conflictId
            incomingRecord.conflictId = conflictId
            return {
              id: conflictId,
              batchId,
              entity: entry.entity,
              alignKey: entry.alignKey,
              path: entry.path,
              localRecord,
              incomingRecord,
              baseRecord: entry.baseRecord ?? null,
              diffs: entry.diffs,
              status: 'pending' as const,
              createdAt: now + index + 1,
              updatedAt: now + index + 1,
              resolvedAt: null,
              resolution: null
            }
          })
          if (newConflicts.length > 0) await db.mergeConflicts.bulkPut(newConflicts)

          // 基线：直接接收 / 新增的记录以最终值重写基线；待决记录先不更新（决议后再写）
          const tables = await readLocalTables()
          const ctx = contextFrom(tables)
          const baseRows: MergeBase[] = []
          plan.items.forEach((item) => {
            if (item.outcome === 'conflict' || !item.localRow) return
            if (item.outcome === 'identical' || item.outcome === 'take-local') return
            baseRows.push(baseFromRow(item.entity, item.localRow as Record<string, unknown>, ctx, Date.now()))
          })
          if (baseRows.length > 0) await db.mergeBases.bulkPut(baseRows)
        }
      )

      const totalConflicts = plan.conflicts.length
      const orphanNote =
        plan.orphans.length > 0
          ? `部分记录因父级缺失/未选定未并入：${plan.orphans.map((o) => o.message).join('；')}`
          : ''
      // 有未决差异或暂缓记录时批次保持开放，便于后续接着处理；否则结案
      const open = totalConflicts > 0 || plan.orphans.length > 0
      await db.mergeBatches.update(batchId, {
        status: open ? 'pending' : 'resolved',
        stats: plan.stats,
        totalConflicts,
        appliedAt: Date.now(),
        resolvedAt: open ? null : Date.now(),
        updatedAt: Date.now(),
        error: orphanNote
      })
      return (await db.mergeBatches.get(batchId)) as MergeBatch
    } catch (err) {
      // 失败：批次保留在本机（含已接收内容与已登记差异），标记 failed 可稍后重试
      const message = err instanceof Error ? err.message : '离线合并执行失败'
      await db.mergeBatches.update(batchId, {
        status: 'failed',
        error: message,
        updatedAt: Date.now()
      })
      error.value = message
      return (await db.mergeBatches.get(batchId)) as MergeBatch
    } finally {
      busy.value = false
    }
  }

  /**
   * 决议一条待决差异。
   * - local：保留站部，外来 pending 副本删除
   * - incoming：接收离线组（写入本地 id 或替换副本），删除外来 pending 副本
   * - both：两份都确认保留（外来副本转正），冲突关闭
   * 决议后更新基线与批次统计；批次内差异全部选定则批次结案。
   */
  async function resolveConflict(
    conflictId: string,
    resolution: 'local' | 'incoming' | 'both'
  ): Promise<void> {
    busy.value = true
    try {
      const conflict = await db.mergeConflicts.get(conflictId)
      if (!conflict || conflict.status !== 'pending') return
      const table = db[ENTITY_TABLE[conflict.entity]]
      const now = Date.now()

      await db.transaction(
        'rw',
        [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.mergeConflicts, db.mergeBases, db.mergeBatches],
        async () => {
          const localRecord = (conflict.localRecord ?? {}) as Record<string, unknown>
          const incomingRecord = (conflict.incomingRecord ?? {}) as Record<string, unknown>
          const localId = String(localRecord.id ?? '')
          const incomingId = String(incomingRecord.id ?? '')

          if (resolution === 'local') {
            if (localId) {
              await table.update(localId, {
                mergeStatus: 'confirmed',
                conflictId: null,
                source: localRecord.source || '站部主台账',
                updatedAt: now
              } as never)
            }
            if (incomingId && incomingId !== localId) await table.delete(incomingId)
          } else if (resolution === 'incoming') {
            // 接收离线值：以本地血缘 id 落最终记录，删除外来 pending 副本
            if (localId) {
              const { id: _ignored, conflictId: _c, mergeStatus: _m, ...incomingBusiness } = incomingRecord
              void _ignored
              void _c
              void _m
              await table.put({
                ...incomingBusiness,
                id: localId,
                mergeStatus: 'confirmed',
                conflictId: null,
                updatedAt: now
              } as never)
            } else if (incomingId) {
              await table.update(incomingId, {
                mergeStatus: 'confirmed',
                conflictId: null,
                updatedAt: now
              } as never)
            }
            if (incomingId && incomingId !== localId && localId) await table.delete(incomingId)
          } else {
            // 两份都保留：站部一份与离线组一份都转正。
            // 礁区 / 站位 / 样带的外来副本在计划阶段外键已指向本地父级，
            // 需要把它名下的子记录（外来新增）改挂到副本 id，形成两棵独立子树。
            if (localId) {
              await table.update(localId, { mergeStatus: 'confirmed', conflictId: null, updatedAt: now } as never)
            }
            if (incomingId) {
              await table.update(incomingId, { mergeStatus: 'confirmed', conflictId: null, updatedAt: now } as never)
            }
            if (resolution === 'both' && incomingId && incomingId !== localId) {
              if (conflict.entity === 'reefs') {
                // 站位的 reefId 指外来礁区副本：原 reefId=localId 且血缘非本地的站点
                const childSites = await db.sites
                  .where('reefId')
                  .equals(localId)
                  .filter((site) => site.batchId === conflict.batchId)
                  .toArray()
                for (const site of childSites) {
                  // 仅移动「随本批次外来、且无本地同名站位」的新增站点
                  const existsLocal = await db.sites
                    .where('reefId')
                    .anyOf([localId, incomingId])
                    .filter((item) => item.id !== site.id && item.no === site.no && item.mergeStatus === 'confirmed')
                    .count()
                  if (existsLocal === 0) await db.sites.update(site.id, { reefId: incomingId })
                }
              } else if (conflict.entity === 'sites') {
                const childBelts = await db.belts
                  .where('siteId')
                  .equals(localId)
                  .filter((belt) => belt.batchId === conflict.batchId)
                  .toArray()
                for (const belt of childBelts) {
                  const existsLocal = await db.belts
                    .where('siteId')
                    .anyOf([localId, incomingId])
                    .filter((item) => item.id !== belt.id && item.no === belt.no && item.mergeStatus === 'confirmed')
                    .count()
                  if (existsLocal === 0) await db.belts.update(belt.id, { siteId: incomingId })
                }
              } else if (conflict.entity === 'belts') {
                // 珊瑚 / 鱼类记录按自然键对齐，冲突时各带不同 id，无需迁移
              }
            }
          }

          // 基线以决议后的（本地血缘）最终记录为准
          const tables = await readLocalTables()
          const ctx: Ctx = contextFrom(tables)
          const finalRow = (await table.get(localId || incomingId)) as Record<string, unknown> | undefined
          if (finalRow) {
            await db.mergeBases.put(baseFromRow(conflict.entity, finalRow, ctx, now))
          }

          await db.mergeConflicts.update(conflictId, {
            status: 'confirmed',
            resolution,
            resolvedAt: now,
            updatedAt: now
          })

          // 批次进度
          const batch = await db.mergeBatches.get(conflict.batchId)
          if (batch) {
            const remaining = await db.mergeConflicts
              .where('batchId')
              .equals(conflict.batchId)
              .filter((item) => item.status === 'pending')
              .count()
            await db.mergeBatches.update(conflict.batchId, {
              status: remaining === 0 ? 'resolved' : 'pending',
              resolvedConflicts: batch.totalConflicts - remaining,
              resolvedAt: remaining === 0 ? now : null,
              updatedAt: now
            })
          }
        }
      )
    } finally {
      busy.value = false
    }
  }

  /** 批量决议：对某批次（或全部）待决差异统一采用同一选择 */
  async function resolveBatch(batchId: string, resolution: 'local' | 'incoming' | 'both'): Promise<number> {
    const list = conflictsOfBatch(batchId).filter((item) => item.status === 'pending')
    for (const conflict of list) {
      await resolveConflict(conflict.id, resolution)
    }
    return list.length
  }

  /**
   * 重试失败批次：以批次留存的原始备份再跑一遍合并（已接收内容幂等，
   * 已登记差异不会重复）。先删除该批次旧的待决标记，避免重复 pending。
   */
  async function retryBatch(batchId: string): Promise<MergeBatch | null> {
    const batch = await db.mergeBatches.get(batchId)
    if (!batch || batch.status !== 'failed') return null
    const payload = batch.payload as BackupPayload
    // 清掉失败批次残留的 pending 标记与冲突行，让重试干净开始
    const staleConflicts = await db.mergeConflicts.where('batchId').equals(batchId).toArray()
    await db.transaction(
      'rw',
      [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.mergeConflicts, db.mergeBatches],
      async () => {
        for (const conflict of staleConflicts) {
          for (const recordKey of ['localRecord', 'incomingRecord'] as const) {
            const record = conflict[recordKey] as Record<string, unknown> | null
            const id = record?.id ? String(record.id) : ''
            if (!id) continue
            const table = db[ENTITY_TABLE[conflict.entity]]
            if (recordKey === 'incomingRecord') {
              await table.delete(id)
            } else {
              await table.update(id, { mergeStatus: 'confirmed', conflictId: null } as never)
            }
          }
        }
        await db.mergeConflicts.where('batchId').equals(batchId).delete()
      }
    )
    await db.mergeBatches.delete(batchId)
    return runMerge(payload, batch.source, batch.fileName)
  }

  /** 放弃失败批次（删除批次头；已接收内容作为正式台账保留） */
  async function discardBatch(batchId: string): Promise<void> {
    const batch = await db.mergeBatches.get(batchId)
    if (!batch) return
    if (batch.status === 'pending' && batch.totalConflicts - batch.resolvedConflicts > 0) {
      // 仍有未选定差异时不允许静默放弃，避免悬挂 pending 记录
      throw new Error('该批次仍有待决差异，请先逐条选定或批量选定后再结案')
    }
    await db.mergeBatches.delete(batchId)
  }

  /** 无待决差异（仅暂缓记录）的开放批次手动结案 */
  async function closeBatch(batchId: string): Promise<void> {
    const batch = await db.mergeBatches.get(batchId)
    if (!batch || batch.status !== 'pending') return
    const remaining = await db.mergeConflicts
      .where('batchId')
      .equals(batchId)
      .filter((item) => item.status === 'pending')
      .count()
    if (remaining > 0) throw new Error('仍有待决差异未选定')
    await db.mergeBatches.update(batchId, { status: 'resolved', resolvedAt: Date.now(), updatedAt: Date.now() })
  }

  return {
    batches,
    conflicts,
    bases,
    busy,
    error,
    start,
    pendingConflicts,
    pendingCount,
    failedBatches,
    openBatches,
    conflictsOfBatch,
    previewMerge,
    runMerge,
    resolveConflict,
    resolveBatch,
    retryBatch,
    discardBatch,
    closeBatch
  }
})
