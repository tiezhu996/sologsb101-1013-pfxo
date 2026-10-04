/**
 * 离线合并核心算法（无 UI 依赖，可被 store / 组件复用）。
 *
 * 三方合并模型：
 * - base：站部派发给普查组时的基线（mergeBases，携带业务字段哈希）
 * - local：回到站部后主台账当前记录
 * - incoming：普查组离线带回的记录
 *
 * 对齐键：礁区按名称；站位按「礁区名称 + 站位编号」；样带按「礁区名称 + 站位编号 + 样带编号」；
 * 珊瑚记录按「样带路径 + 属名 + 形态」；鱼类计数按「样带路径 + 科名 + 体长段 + 类别」。
 * 同时优先按 originId（派发血缘主键）对齐，自然键兜底，兼容改名。
 *
 * 判定：
 * - 三边一致 → 跳过；仅一边相对基线改动 → 直接接收；
 * - 两边都改过（或旧备份无基线且两边不同）→ 保留两份并标来源，进入待决队列，选定前不进汇总。
 */
import type { BackupPayload } from '@/utils/db'
import { MASTER_BATCH_ID, createId } from '@/utils/db'
import type { MergeBase, MergeEntityName, FieldDiff, MergeItem, MergePlan } from '@/types/merge'
import { SOURCE_MASTER } from '@/types/merge'

type Row = Record<string, unknown>

/** 各实体参与比对的业务字段（不含 id / 外键 / 时间戳 / 合并标记） */
export const ENTITY_FIELDS: Record<MergeEntityName, Array<{ field: string; label: string }>> = {
  reefs: [
    { field: 'name', label: '礁区名' },
    { field: 'location', label: '位置' },
    { field: 'areaKm2', label: '面积(km²)' },
    { field: 'protectStatus', label: '保护区状态' },
    { field: 'manager', label: '管理单位' }
  ],
  sites: [
    { field: 'no', label: '站位编号' },
    { field: 'lat', label: '纬度' },
    { field: 'lng', label: '经度' },
    { field: 'depthM', label: '水深(m)' },
    { field: 'substrate', label: '底质' }
  ],
  belts: [
    { field: 'no', label: '样带编号' },
    { field: 'lengthM', label: '长度(m)' },
    { field: 'orientation', label: '朝向' },
    { field: 'surveyDate', label: '调查日期' },
    { field: 'observer', label: '调查人' }
  ],
  corals: [
    { field: 'genus', label: '属名' },
    { field: 'form', label: '形态' },
    { field: 'coverCm', label: '覆盖长度(cm)' },
    { field: 'bleachLevel', label: '白化等级' },
    { field: 'remark', label: '备注' }
  ],
  fishes: [
    { field: 'family', label: '科名' },
    { field: 'count', label: '数量' },
    { field: 'sizeClass', label: '体长段' },
    { field: 'category', label: '类别' }
  ]
}

/** 各实体的外键字段（重映射，不参与哈希） */
const PARENT_FIELD: Partial<Record<MergeEntityName, string>> = {
  sites: 'reefId',
  belts: 'siteId',
  corals: 'beltId',
  fishes: 'beltId'
}

const ID_PREFIX: Record<MergeEntityName, string> = {
  reefs: 'reef',
  sites: 'site',
  belts: 'belt',
  corals: 'cor',
  fishes: 'fsh'
}

/* --------------------------------- 小工具 -------------------------------- */

export function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : []
}

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

const normName = (value: unknown): string => text(value).trim()

/** 稳定哈希（djb2），只用于判定字段是否变化，不做安全用途 */
export function hashObject(value: unknown): string {
  const json = JSON.stringify(value)
  let hash = 5381
  for (let i = 0; i < json.length; i += 1) {
    hash = ((hash << 5) + hash + json.charCodeAt(i)) | 0
  }
  return `h${(hash >>> 0).toString(36)}`
}

/** 提取业务字段（稳定键序） */
function businessFields(entity: MergeEntityName, row: Row): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  ENTITY_FIELDS[entity].forEach(({ field }) => {
    result[field] = row[field]
  })
  return result
}

export function businessHash(entity: MergeEntityName, row: Row): string {
  return hashObject(businessFields(entity, row))
}

/* -------------------------------- 上下文解析 ------------------------------- */

export interface Ctx {
  reefs: Row[]
  sites: Row[]
  belts: Row[]
  reefByName: Map<string, Row>
  siteByKey: Map<string, Row>
  beltByKey: Map<string, Row>
}

export function buildCtx(reefs: Row[], sites: Row[], belts: Row[]): Ctx {
  const reefByName = new Map<string, Row>()
  reefs.forEach((row) => reefByName.set(normName(row.name), row))
  const siteByKey = new Map<string, Row>()
  const beltByKey = new Map<string, Row>()
  sites.forEach((row) => {
    const reef = reefs.find((item) => item.id === row.reefId)
    siteByKey.set(`${normName(reef?.name)}|${normName(row.no)}`, row)
  })
  belts.forEach((row) => {
    const site = sites.find((item) => item.id === row.siteId)
    const reef = site ? reefs.find((item) => item.id === site.reefId) : undefined
    beltByKey.set(`${normName(reef?.name)}|${normName(site?.no)}|${normName(row.no)}`, row)
  })
  return { reefs, sites, belts, reefByName, siteByKey, beltByKey }
}

/** 记录所在层级路径（冲突页定位用） */
export function pathOf(entity: MergeEntityName, row: Row, ctx: Ctx): string {
  if (entity === 'reefs') return normName(row.name)
  if (entity === 'sites') {
    const reef = ctx.reefs.find((item) => item.id === row.reefId)
    return `${normName(reef?.name)} / ${normName(row.no)}`
  }
  const belt = entity === 'belts' ? row : ctx.belts.find((item) => item.id === row.beltId)
  const site = belt ? ctx.sites.find((item) => item.id === belt.siteId) : undefined
  const reef = site ? ctx.reefs.find((item) => item.id === site.reefId) : undefined
  const beltPath = `${normName(reef?.name)} / ${normName(site?.no)} / ${normName(belt?.no)}`
  if (entity === 'belts') return beltPath
  const self =
    entity === 'corals' ? `${text(row.genus)}·${text(row.form)}` : `${text(row.family)}·${text(row.sizeClass)}`
  return `${beltPath} / ${self}`
}

function naturalKey(entity: MergeEntityName, row: Row, ctx: Ctx): string {
  if (entity === 'reefs') return `reef|${normName(row.name)}`
  const path = pathOf(entity, row, ctx)
  const prefix = ID_PREFIX[entity]
  return `${prefix}|${path}`
}

/* -------------------------------- 差异计算 -------------------------------- */

function fieldText(field: string, row: Row | null | undefined): string | null {
  if (!row || !(field in row)) return null
  const value = row[field]
  if (value === null || value === undefined || value === '') return null
  return text(value)
}

export function diffFields(
  entity: MergeEntityName,
  local: Row | null,
  incoming: Row | null,
  base: Row | null
): FieldDiff[] {
  return ENTITY_FIELDS[entity]
    .map(({ field, label }) => ({
      field,
      label,
      base: fieldText(field, base),
      local: fieldText(field, local),
      incoming: fieldText(field, incoming)
    }))
    .filter((diff) => diff.local !== diff.incoming)
}

/* -------------------------------- 外键重映射 ------------------------------- */

/**
 * 预先把外来记录外键重映射到「将写入本机的父记录 id」。
 * 父级已对齐（接收或待决都一样）→ 挂本地父；父级为新增 → 保留外来新增父 id。
 */
function remapIncomingIds(
  incoming: Pick<BackupPayload, 'reefs' | 'sites' | 'belts' | 'corals' | 'fishes'>,
  localCtx: Ctx
): { rows: Record<MergeEntityName, Row[]> } {
  const reefIdMap = new Map<string, string>()
  const siteIdMap = new Map<string, string>()
  const beltIdMap = new Map<string, string>()
  const inReefs = asRows(incoming.reefs)
  const inSites = asRows(incoming.sites)
  const inBelts = asRows(incoming.belts)
  const inCtx = buildCtx(inReefs, inSites, inBelts)

  inReefs.forEach((row) => {
    const local = localCtx.reefByName.get(normName(row.name))
    reefIdMap.set(text(row.id), local ? text(local.id) : text(row.id))
  })
  inSites.forEach((row) => {
    const reef = inReefs.find((item) => item.id === row.reefId)
    const local = localCtx.siteByKey.get(`${normName(reef?.name)}|${normName(row.no)}`)
    siteIdMap.set(text(row.id), local ? text(local.id) : text(row.id))
  })
  inBelts.forEach((row) => {
    const site = inSites.find((item) => item.id === row.siteId)
    const reef = site ? inReefs.find((item) => item.id === site.reefId) : undefined
    const local = localCtx.beltByKey.get(
      `${normName(reef?.name)}|${normName(site?.no)}|${normName(row.no)}`
    )
    beltIdMap.set(text(row.id), local ? text(local.id) : text(row.id))
  })

  const remap = (entity: MergeEntityName, list: Row[]): Row[] => {
    const parentField = PARENT_FIELD[entity]
    if (!parentField) return list.map((row) => ({ ...row }))
    const map = entity === 'sites' ? reefIdMap : entity === 'belts' ? siteIdMap : beltIdMap
    return list.map((row) => {
      const oldId = text(row[parentField])
      return { ...row, [parentField]: map.get(oldId) ?? oldId }
    })
  }

  return {
    rows: {
      reefs: remap('reefs', inReefs),
      sites: remap('sites', inSites),
      belts: remap('belts', inBelts),
      corals: remap('corals', asRows(incoming.corals)),
      fishes: remap('fishes', asRows(incoming.fishes))
    }
  }
}

/* -------------------------------- 合并计划 -------------------------------- */

export interface BuildPlanOptions {
  batchId: string
  source: string
}

/**
 * 生成离线合并计划（只做计算，不写库）。
 * @param payload 已校验并归一化的外来备份
 * @param local   当前主台账五张表
 * @param bases   站部派发基线
 */
export function buildMergePlan(
  payload: Pick<BackupPayload, 'reefs' | 'sites' | 'belts' | 'corals' | 'fishes'>,
  local: Pick<BackupPayload, 'reefs' | 'sites' | 'belts' | 'corals' | 'fishes'>,
  bases: MergeBase[],
  options: BuildPlanOptions
): MergePlan {
  const localRows: Record<MergeEntityName, Row[]> = {
    reefs: asRows(local.reefs),
    sites: asRows(local.sites),
    belts: asRows(local.belts),
    corals: asRows(local.corals),
    fishes: asRows(local.fishes)
  }
  const localCtx = buildCtx(localRows.reefs, localRows.sites, localRows.belts)
  const { rows: incomingRows } = remapIncomingIds(payload, localCtx)

  const baseByKey = new Map<string, MergeBase>()
  bases.forEach((base) => {
    baseByKey.set(`${base.entity}|${base.naturalKey}`, base)
    if (base.originId) baseByKey.set(`${base.entity}|oid:${base.originId}`, base)
  })

  const items: MergeItem[] = []
  const conflicts: MergePlan['conflicts'] = []
  const orphans: MergePlan['orphans'] = []
  let baseMissing = 0
  const emptyStats = () => ({ accepted: 0, conflicts: 0, identical: 0 })
  const stats: MergePlan['stats'] = {
    reefs: emptyStats(),
    sites: emptyStats(),
    belts: emptyStats(),
    corals: emptyStats(),
    fishes: emptyStats()
  }
  /** 本批次新增父记录的 id（子记录外键解析时算「父存在」） */
  const addedParentIds: Record<MergeEntityName, Set<string>> = {
    reefs: new Set(),
    sites: new Set(),
    belts: new Set(),
    corals: new Set(),
    fishes: new Set()
  }
  const now = Date.now()

  function findLocal(entity: MergeEntityName, row: Row): Row | null {
    // 外来行的外键已重映射到本机父 id，因此用本地上下文计算自然键
    const key = naturalKey(entity, row, localCtx)
    const byKey = localRows[entity].find(
      (item) => item.mergeStatus === 'confirmed' && naturalKey(entity, item, localCtx) === key
    )
    if (byKey) return byKey
    const origin = text(row.originId || row.id)
    return (
      localRows[entity].find(
        (item) => item.mergeStatus === 'confirmed' && text(item.originId) === origin
      ) ?? null
    )
  }

  function findBase(entity: MergeEntityName, row: Row): MergeBase | null {
    const key = naturalKey(entity, row, localCtx).replace(/^[a-z]+\|/, '')
    return (
      baseByKey.get(`${entity}|${key}`) ??
      baseByKey.get(`${entity}|oid:${text(row.originId || row.id)}`) ??
      null
    )
  }

  /** 待落库的外来行：盖来源 / 批次 / 血缘标记 */
  function stampIncoming(row: Row, status: 'confirmed' | 'pending', idPrefix?: string): Row {
    return {
      ...row,
      id: idPrefix ? createId(idPrefix) : text(row.id),
      source: options.source,
      batchId: options.batchId,
      mergeStatus: status,
      conflictId: null,
      originId: text(row.originId || row.id),
      updatedAt: now
    }
  }

  function parentResolvable(entity: MergeEntityName, row: Row): boolean {
    const parentField = PARENT_FIELD[entity]
    if (!parentField) return true
    const parentEntity = (
      entity === 'sites' ? 'reefs' : entity === 'belts' ? 'sites' : 'belts'
    ) as MergeEntityName
    const parentId = text(row[parentField])
    const existsInLocal = localRows[parentEntity].some((item) => text(item.id) === parentId && item.mergeStatus === 'confirmed')
    const addedByBatch = addedParentIds[parentEntity]?.has(parentId)
    return existsInLocal || addedByBatch
  }

  function processEntity(entity: MergeEntityName): void {
    incomingRows[entity].forEach((row) => {
      if (!parentResolvable(entity, row)) {
        orphans.push({ entity, message: `父级记录缺失或未选定：${pathOf(entity, row, localCtx)}` })
        return
      }

      const local = findLocal(entity, row)
      const base = findBase(entity, row)
      const key = naturalKey(entity, row, localCtx)
      const path = pathOf(entity, row, localCtx)
      const incomingHash = businessHash(entity, row)
      const localHash = local ? businessHash(entity, local) : null
      const baseHash = base?.hash ?? null
      const baseRow = (base?.record as Row | undefined) ?? null

      if (!local) {
        // 外来新增（基线若存在则为站部后删/改，仍以接收离线值为准）
        const stamped = stampIncoming(row, 'confirmed')
        items.push({ entity, outcome: 'add-incoming', alignKey: key, path, localId: null, incomingId: text(row.id), localRow: stamped, baseRow })
        stats[entity].accepted += 1
        if (entity !== 'fishes') addedParentIds[entity].add(text(row.id))
        return
      }

      if (localHash === incomingHash) {
        items.push({ entity, outcome: 'identical', alignKey: key, path, localId: text(local.id), incomingId: text(row.id), baseRow })
        stats[entity].identical += 1
        return
      }

      if (baseHash !== null) {
        const localChanged = localHash !== baseHash
        const incomingChanged = incomingHash !== baseHash
        if (!localChanged && incomingChanged) {
          // 仅离线组改过 → 直接接收业务字段
          const merged: Row = {
            ...local,
            ...businessFields(entity, row),
            source: options.source,
            batchId: options.batchId,
            mergeStatus: 'confirmed',
            conflictId: null,
            originId: text(local.originId || local.id),
            updatedAt: now
          }
          items.push({ entity, outcome: 'take-incoming', alignKey: key, path, localId: text(local.id), incomingId: text(row.id), localRow: merged, baseRow })
          stats[entity].accepted += 1
          return
        }
        if (localChanged && !incomingChanged) {
          // 仅站部改过 → 保留站部
          items.push({ entity, outcome: 'take-local', alignKey: key, path, localId: text(local.id), incomingId: text(row.id), localRow: local, baseRow })
          stats[entity].identical += 1
          return
        }
        // 两边都改过 → 落到下面的待决分支
      } else {
        baseMissing += 1
      }

      // 待决：本地一份转 pending，外来副本换新 id 另存一份 pending，均标来源
      const localPending: Row = {
        ...local,
        mergeStatus: 'pending',
        updatedAt: now
      }
      const incomingCopy = stampIncoming(row, 'pending', ID_PREFIX[entity])
      const diffs = diffFields(entity, local, row, baseRow)
      items.push({
        entity,
        outcome: 'conflict',
        alignKey: key,
        path,
        localId: text(local.id),
        incomingId: text(row.id),
        localRow: localPending,
        incomingRow: incomingCopy,
        baseRow,
        diffs
      })
      conflicts.push({
        entity,
        alignKey: key,
        path,
        localRecord: localPending,
        incomingRecord: incomingCopy,
        baseRecord: baseRow,
        diffs
      })
      stats[entity].conflicts += 1
    })
  }

  // 父级先行，保证子记录外键可解析（外键已统一重映射到本机，上下文一律取本地）
  processEntity('reefs')
  processEntity('sites')
  processEntity('belts')
  processEntity('corals')
  processEntity('fishes')

  return { items, conflicts, stats, baseMissing, orphans }
}

/* ------------------------------ 基线 / 归一化 ------------------------------ */

/** 决议后写回基线（自然键 + 当前业务哈希；originId 兜底改名对齐） */
export function baseFromRow(entity: MergeEntityName, row: Row, ctx: Ctx, now: number): MergeBase {
  const key = naturalKey(entity, row, ctx)
  return {
    id: `mb_${hashObject(`${entity}|${key}`)}`,
    entity,
    naturalKey: key.replace(/^[a-z]+\|/, ''),
    originId: text(row.originId || row.id),
    hash: businessHash(entity, row),
    record: businessFields(entity, row),
    updatedAt: now
  }
}

/** 从完整五表构造上下文（决议时复用） */
export function contextFrom(tables: Pick<BackupPayload, 'reefs' | 'sites' | 'belts'>): Ctx {
  return buildCtx(asRows(tables.reefs), asRows(tables.sites), asRows(tables.belts))
}

/** 归一化外部备份业务行：补齐来源 / 合并状态字段（兼容 v2 旧备份） */
export function normalizeProvenance(
  payload: Pick<BackupPayload, 'reefs' | 'sites' | 'belts' | 'corals' | 'fishes'>,
  fallbackSource: string
): Pick<BackupPayload, 'reefs' | 'sites' | 'belts' | 'corals' | 'fishes'> {
  const fix = <T>(list: T[]): T[] =>
    list.map((item) => {
      const row = item as Row
      return {
        ...row,
        source: typeof row.source === 'string' && row.source ? row.source : fallbackSource,
        batchId: typeof row.batchId === 'string' && row.batchId ? row.batchId : MASTER_BATCH_ID,
        mergeStatus: row.mergeStatus === 'pending' ? ('pending' as const) : ('confirmed' as const),
        conflictId: typeof row.conflictId === 'string' ? row.conflictId : null,
        originId: typeof row.originId === 'string' && row.originId ? row.originId : text(row.id)
      } as T
    })
  return {
    reefs: fix(payload.reefs),
    sites: fix(payload.sites),
    belts: fix(payload.belts),
    corals: fix(payload.corals),
    fishes: fix(payload.fishes)
  }
}

/** 来源是否为站部主台账 */
export function isMasterSource(source: string | null | undefined): boolean {
  return !source || source === SOURCE_MASTER
}

/** 生成批次号：MR + 年份 + 三位序号 */
export function nextBatchNo(existingCount: number): string {
  const year = new Date().getFullYear()
  return `MR${year}${String(existingCount + 1).padStart(3, '0')}`
}
