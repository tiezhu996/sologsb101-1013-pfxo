/**
 * 离线合并服务：批次暂存、合并提交、待选差异选定（含级联）、放弃回滚与批次导出。
 *
 * 故障口径（对应外业流程）：
 * - 原批次文件始终随批次行完整留在本机 syncBatches 表；
 * - 合并在单个 Dexie 事务内完成，事务失败时主台账五表保持原样、批次标 failed，可原样重试；
 * - 已确认（added/accepted）内容与待选差异（pending 两份）都在库里，关机 / 刷新后恢复批次即可继续选定；
 * - 放弃批次会回滚「该批次写入的全部行」（added 副本、accepted 的主台账行无法自动还原旧值，
 *   因此 accepted 行保留并改挂来源「主台账」，批次说明里明确提示）。
 */
import { db, createId } from '@/utils/db'
import type { BackupPayload } from '@/utils/db'
import type { ConflictMeta, SyncBatch } from '@/types/sync'
import { BATCH_STATUS_LABELS, SOURCE_STATION } from '@/types/sync'
import {
  TABLE_FIELDS,
  TABLE_LABELS,
  planMerge,
  sumStats,
  type BusinessTable,
  type MergePlan
} from '@/utils/merge'

export { TABLE_LABELS, TABLE_FIELDS, BATCH_STATUS_LABELS, sumStats }

/** 暂存一个待合并批次（只写 syncBatches，不动主台账） */
export async function stageBatch(params: {
  payload: BackupPayload
  fileName: string
  groupName: string
}): Promise<SyncBatch> {
  const now = Date.now()
  const batch: SyncBatch = {
    id: createId('batch'),
    groupName: params.groupName.trim() || params.payload.groupName?.trim() || '上岛调查组',
    fileName: params.fileName,
    status: 'staged',
    payload: params.payload,
    base: params.payload.base ?? null,
    createdAt: now,
    mergedAt: null,
    resolvedAt: null,
    lastError: '',
    stats: createEmptyStats(),
    conflicts: []
  }
  await db.syncBatches.put(batch)
  return batch
}

function createEmptyStats() {
  const zero = () => ({ added: 0, accepted: 0, unchanged: 0, conflicts: 0 })
  return { reefs: zero(), sites: zero(), belts: zero(), corals: zero(), fishes: zero() }
}

/** 纯预览：不落库，返回合并计划与合计统计 */
export async function previewMerge(batch: SyncBatch): Promise<{ plan: MergePlan; totals: ReturnType<typeof sumStats> }> {
  const local = await readLocalPayload()
  const plan = planMerge(local, batch.payload, batch.id, batch.groupName)
  return { plan, totals: sumStats(plan.stats) }
}

async function readLocalPayload(): Promise<Pick<BackupPayload, BusinessTable>> {
  const [reefs, sites, belts, corals, fishes] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray()
  ])
  return { reefs, sites, belts, corals, fishes }
}

/**
 * 执行合并：一个事务内重算计划并整体替换五表。
 * 事务抛错 → 五表回滚原状，批次标 failed（原批次保留，可重试）。
 */
export async function commitMerge(batchId: string): Promise<SyncBatch> {
  const stored = await db.syncBatches.get(batchId)
  if (!stored) throw new Error('批次不存在或已被删除')
  try {
    const local = await readLocalPayload()
    const plan = planMerge(local, stored.payload, stored.id, stored.groupName)
    await db.transaction('rw', [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.syncBatches], async () => {
      await db.reefs.bulkPut(plan.reefs)
      await db.sites.bulkPut(plan.sites)
      await db.belts.bulkPut(plan.belts)
      await db.corals.bulkPut(plan.corals)
      await db.fishes.bulkPut(plan.fishes)
      const updated: SyncBatch = {
        ...stored,
        status: plan.conflicts.length > 0 ? 'merged' : 'resolved',
        stats: plan.stats,
        conflicts: plan.conflicts,
        mergedAt: Date.now(),
        resolvedAt: plan.conflicts.length > 0 ? null : Date.now(),
        lastError: ''
      }
      await db.syncBatches.put(updated)
    })
    return (await db.syncBatches.get(batchId)) as SyncBatch
  } catch (error) {
    const failed: SyncBatch = {
      ...stored,
      status: 'failed',
      lastError: error instanceof Error ? error.message : '合并事务失败'
    }
    await db.syncBatches.put(failed)
    return failed
  }
}

/** 待选视图行（附带两侧实际记录） */
export interface ConflictViewRow extends ConflictMeta {
  tableLabel: string
  localRow: Record<string, unknown> | null
  incomingRow: Record<string, unknown> | null
}

const TABLE_ACCESSOR: Record<BusinessTable, () => (typeof db)[BusinessTable]> = {
  reefs: () => db.reefs,
  sites: () => db.sites,
  belts: () => db.belts,
  corals: () => db.corals,
  fishes: () => db.fishes
}

/** 组装某批次的待选差异视图（两侧记录可能已被人工删除，此时为 null） */
export async function buildConflictViews(batch: SyncBatch): Promise<ConflictViewRow[]> {
  const tables = {
    reefs: new Map((await db.reefs.toArray()).map((row) => [row.id, row])),
    sites: new Map((await db.sites.toArray()).map((row) => [row.id, row])),
    belts: new Map((await db.belts.toArray()).map((row) => [row.id, row])),
    corals: new Map((await db.corals.toArray()).map((row) => [row.id, row])),
    fishes: new Map((await db.fishes.toArray()).map((row) => [row.id, row]))
  }
  return batch.conflicts.map((conflict) => ({
    ...conflict,
    tableLabel: TABLE_LABELS[conflict.table],
    localRow: (tables[conflict.table].get(conflict.localId) as unknown as Record<string, unknown>) ?? null,
    incomingRow: (tables[conflict.table].get(conflict.incomingId) as unknown as Record<string, unknown>) ?? null
  }))
}

/**
 * 选定一条差异的处理结果。
 * @param winner local=保留主台账侧（删除调查组副本）；incoming=采用调查组侧（删除主台账侧并扶正副本）
 *
 * 父级（礁区/站位/样带）选 incoming 时，把调查组副本下挂的未决子记录级联改挂到扶正后的父级，
 * 保证待选明细仍能逐条选定；子记录冲突也一并选定父级选择的同侧。
 */
export async function resolveConflict(
  batchId: string,
  conflictId: string,
  winner: 'local' | 'incoming'
): Promise<SyncBatch> {
  const batch = await db.syncBatches.get(batchId)
  if (!batch) throw new Error('批次不存在或已被删除')
  const conflict = batch.conflicts.find((item) => item.conflictId === conflictId)
  if (!conflict) throw new Error('待选差异不存在')
  if (conflict.resolved) return batch

  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.syncBatches],
    async () => {
      const table = TABLE_ACCESSOR[conflict.table]()
      const loserId = winner === 'local' ? conflict.incomingId : conflict.localId
      const winnerId = winner === 'local' ? conflict.localId : conflict.incomingId
      await table.delete(loserId)

      if (winner === 'incoming') {
        // 扶正调查组副本：去掉未决标记，来源仍保留调查组名以便溯源
        await table.update(winnerId, {
          pending: false,
          conflictId: '',
          updatedAt: Date.now()
        } as never)
      } else {
        await table.update(winnerId, {
          pending: false,
          conflictId: '',
          source: SOURCE_STATION,
          updatedAt: Date.now()
        } as never)
      }
      await cascadeChildren({
        parentTable: conflict.table,
        winner,
        keptParentId: winnerId,
        removedParentId: loserId,
        conflicts: batch.conflicts
      })

      const now = Date.now()
      const nextConflicts = batch.conflicts.map((item) =>
        item.resolved || item.conflictId !== conflictId
          ? item
          : { ...item, resolved: true, winner, resolvedAt: now }
      )
      const unresolved = nextConflicts.filter((item) => !item.resolved).length
      await db.syncBatches.put({
        ...batch,
        conflicts: nextConflicts,
        status: unresolved === 0 ? 'resolved' : 'merged',
        resolvedAt: unresolved === 0 ? now : null
      })
    }
  )
  return (await db.syncBatches.get(batchId)) as SyncBatch
}

/** 子表与外键描述 */
const CHILD_SPECS: Array<{
  parent: BusinessTable
  child: BusinessTable
  foreignKey: 'reefId' | 'siteId' | 'beltId'
}> = [
  { parent: 'reefs', child: 'sites', foreignKey: 'reefId' },
  { parent: 'sites', child: 'belts', foreignKey: 'siteId' },
  { parent: 'belts', child: 'corals', foreignKey: 'beltId' },
  { parent: 'belts', child: 'fishes', foreignKey: 'beltId' }
]

/**
 * 父记录选定后，沿 礁区→站位→样带→珊瑚/鱼类 向下传播（递归到底，保证外键不悬挂）：
 * - incoming 胜：调查组父副本扶正；其下调查组子副本自动选 incoming（删除对应主台账副本），
 *   调查组新增（非未决）子行改挂扶正父级；
 * - local 胜：调查组父副本被删；其下调查组子副本改挂保留父级，与主台账副本继续并存待选。
 */
async function cascadeChildren(args: {
  parentTable: BusinessTable
  winner: 'local' | 'incoming'
  keptParentId: string
  removedParentId: string
  conflicts: ConflictMeta[]
}): Promise<void> {
  for (const spec of CHILD_SPECS.filter((item) => item.parent === args.parentTable)) {
    const childTable = TABLE_ACCESSOR[spec.child]()
    // 先把所有引用「被删父副本」的子行取出（取后逐条重定向 / 删除，避免重复遍历）
    const children = await childTable.where(spec.foreignKey).equals(args.removedParentId).toArray()

    // 该层若调查组子副本与主台账子副本成对未决，记录传播到下一层的两个 id
    let nextKeptId = args.keptParentId
    let nextRemovedId = args.removedParentId
    let hasConflictPair = false

    for (const childRaw of children) {
      const row = childRaw as unknown as Record<string, unknown>
      if (row.pending !== true) {
        await childTable.update(childRaw.id, { [spec.foreignKey]: args.keptParentId, updatedAt: Date.now() } as never)
        continue
      }
      const childConflict = args.conflicts.find(
        (item) => item.table === spec.child && item.incomingId === childRaw.id && !item.resolved
      )
      if (args.winner === 'incoming' && childConflict) {
        await childTable.delete(childConflict.localId)
        await childTable.put({
          ...row,
          [spec.foreignKey]: args.keptParentId,
          pending: false,
          conflictId: '',
          updatedAt: Date.now()
        } as never)
        childConflict.resolved = true
        childConflict.winner = 'incoming'
        childConflict.resolvedAt = Date.now()
        nextKeptId = childConflict.incomingId
        nextRemovedId = childConflict.localId
        hasConflictPair = true
      } else {
        // local 胜：调查组子副本改挂保留父级，继续与主台账副本并存
        // incoming 胜但找不到配对（理论上不应发生）：安全改挂，保留待选
        await childTable.update(childRaw.id, { [spec.foreignKey]: args.keptParentId, updatedAt: Date.now() } as never)
      }
    }

    // 继续向孙级传播：
    // - incoming 胜且本层有自动选定的冲突对：孙级调查组副本跟随扶正子副本
    // - local 胜：孙级调查组副本原挂在「调查组子副本」下，该副本已改挂到保留父级，
    //   但孙级的直接父是未决的子副本，本身仍存在 → 不需要再移动孙级（其父亲还在）
    if (args.winner === 'incoming' && hasConflictPair) {
      await cascadeChildren({
        parentTable: spec.child,
        winner: 'incoming',
        keptParentId: nextKeptId,
        removedParentId: nextRemovedId,
        conflicts: args.conflicts
      })
    }
  }
}

/** 一键选定全部未决差异（同侧批量处理；逐条 resolveConflict 以复用级联规则） */
export async function resolveAllConflicts(
  batchId: string,
  winner: 'local' | 'incoming'
): Promise<SyncBatch> {
  let batch = await db.syncBatches.get(batchId)
  if (!batch) throw new Error('批次不存在或已被删除')
  // 父级先处理（礁区 → 站位 → 样带 → 明细），保证级联外键正确
  const order: BusinessTable[] = ['reefs', 'sites', 'belts', 'corals', 'fishes']
  for (const table of order) {
    batch = await db.syncBatches.get(batchId)
    if (!batch) throw new Error('批次不存在或已被删除')
    const pending = batch.conflicts.filter((item) => item.table === table && !item.resolved)
    for (const conflict of pending) {
      const latest = await db.syncBatches.get(batchId)
      if (!latest) continue
      if (latest.conflicts.find((item) => item.conflictId === conflict.conflictId)?.resolved) continue
      await resolveConflict(batchId, conflict.conflictId, winner)
    }
  }
  return (await db.syncBatches.get(batchId)) as SyncBatch
}

/**
 * 放弃批次：
 * - 调查组写入的「新增行」（batchId 命中且从未参与冲突）整行删除；
 * - 两边都改的调查组副本按冲突清单 incomingId 精确删除；
 * - 对应的主台账侧行解除未决标记（回到合并前可统计状态）；
 * 直接接收（仅调查组改过）的行没有保留旧值，无法自动回滚 → 保留并回落来源为「主台账」。
 */
export async function discardBatch(batchId: string): Promise<void> {
  const batch = await db.syncBatches.get(batchId)
  if (!batch) return
  await db.transaction('rw', [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.syncBatches], async () => {
    const incomingConflictIds = new Map<BusinessTable, Set<string>>()
    const localConflictIds = new Map<BusinessTable, Set<string>>()
    for (const tableName of ['reefs', 'sites', 'belts', 'corals', 'fishes'] as BusinessTable[]) {
      incomingConflictIds.set(tableName, new Set())
      localConflictIds.set(tableName, new Set())
    }
    batch.conflicts.forEach((conflict) => {
      incomingConflictIds.get(conflict.table)?.add(conflict.incomingId)
      localConflictIds.get(conflict.table)?.add(conflict.localId)
    })

    for (const tableName of ['corals', 'fishes', 'belts', 'sites', 'reefs'] as BusinessTable[]) {
      const table = TABLE_ACCESSOR[tableName]()
      const rows = await table.toArray()
      const incomingSet = incomingConflictIds.get(tableName) as Set<string>
      const localSet = localConflictIds.get(tableName) as Set<string>
      const deleteIds = rows
        .filter((row) => {
          if (incomingSet.has(row.id)) return true // 调查组冲突副本
          // 调查组新增行（带来源标记、非主台账 id、不在 local 清单）
          return (
            (row as { batchId?: string }).batchId === batchId &&
            !localSet.has(row.id) &&
            (row as { source?: string }).source !== SOURCE_STATION
          )
        })
        .map((row) => row.id)
      if (deleteIds.length > 0) await table.bulkDelete(deleteIds)

      // 主台账侧未决行解除标记（行本身保留）
      for (const id of localSet) {
        const row = await table.get(id as never)
        if (row && (row as { pending?: boolean }).pending === true) {
          await table.update(id as never, {
            pending: false,
            conflictId: '',
            source: SOURCE_STATION,
            updatedAt: Date.now()
          } as never)
        }
      }
      // 直接接收行：保留，但回落来源标记，避免继续挂在已放弃的批次上
      const acceptedRows = (await table.toArray()).filter(
        (row) =>
          (row as { batchId?: string }).batchId === batchId &&
          (row as { source?: string }).source === SOURCE_STATION &&
          (row as { pending?: boolean }).pending !== true
      )
      for (const row of acceptedRows) {
        await table.update(row.id, { batchId: '', updatedAt: Date.now() } as never)
      }
    }

    await db.syncBatches.put({
      ...batch,
      status: 'resolved',
      resolvedAt: Date.now(),
      conflicts: batch.conflicts.map((item) =>
        item.resolved ? item : { ...item, resolved: true, winner: 'local' as const, resolvedAt: Date.now() }
      ),
      lastError: '已放弃合并：调查组副本已移除，直接接收的主台账行保留'
    })
  })
}

/** 彻底删除批次记录（原批次文件也从本机移除；主台账行不动） */
export async function deleteBatchRecord(batchId: string): Promise<void> {
  await db.syncBatches.delete(batchId)
}

/** 列出本机保留的全部批次（原批次可恢复） */
export async function listBatches(): Promise<SyncBatch[]> {
  const rows = await db.syncBatches.toArray()
  return rows.sort((a, b) => b.createdAt - a.createdAt)
}
