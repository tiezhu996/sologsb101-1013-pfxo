/**
 * 离线合并核心算法（纯函数，不触碰数据库）：
 * - 礁区按名称、站位按「所属礁区 + 编号」、样带按「所属站位 + 编号」对齐；
 *   珊瑚/鱼类先按原始 id 对齐，找不到再按业务键（属名+形态 / 科名+体长段+类别）补对齐。
 * - 三方判定（主台账 local / 离站基线 base / 调查组 incoming）：
 *   仅一边改过直接接收；两边都改或基线缺失且两边不一致则保留两份并标来源、置 pending。
 * - 选定前 pending 行不进入覆盖度汇总（由调用方过滤）。
 */
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'
import type { BackupPayload } from '@/utils/db'
import { createId } from '@/utils/db'
import type {
  BaseManifest,
  ConflictMeta,
  MergeStats,
  TableMergeStats
} from '@/types/sync'
import { SOURCE_STATION, SOURCE_UNKNOWN, createEmptyTableMergeStats } from '@/types/sync'

export type BusinessTable = 'reefs' | 'sites' | 'belts' | 'corals' | 'fishes'

export const TABLE_LABELS: Record<BusinessTable, string> = {
  reefs: '礁区',
  sites: '站位',
  belts: '样带',
  corals: '珊瑚记录',
  fishes: '鱼类计数'
}

/** 各表参与指纹与逐字段对比的业务字段（id / 时间戳 / 来源标记不参与） */
export const TABLE_FIELDS: Record<BusinessTable, string[]> = {
  reefs: ['name', 'location', 'areaKm2', 'protectStatus', 'manager'],
  sites: ['reefId', 'no', 'lat', 'lng', 'depthM', 'substrate'],
  belts: ['siteId', 'no', 'lengthM', 'orientation', 'surveyDate', 'observer'],
  corals: ['beltId', 'genus', 'form', 'coverCm', 'bleachLevel', 'remark'],
  fishes: ['beltId', 'family', 'count', 'sizeClass', 'category']
}

/** 字段中文标签（待选差异对比用） */
export const FIELD_LABELS: Record<string, string> = {
  name: '礁区名',
  location: '位置',
  areaKm2: '面积',
  protectStatus: '保护区状态',
  manager: '管理单位',
  reefId: '所属礁区',
  no: '编号',
  lat: '纬度',
  lng: '经度',
  depthM: '水深',
  substrate: '底质',
  siteId: '所属站位',
  lengthM: '样带长度',
  orientation: '朝向',
  surveyDate: '调查日期',
  observer: '调查人',
  beltId: '所属样带',
  genus: '属名',
  form: '形态',
  coverCm: '覆盖长度',
  bleachLevel: '白化等级',
  remark: '备注',
  family: '科名',
  count: '数量',
  sizeClass: '体长段',
  category: '类别'
}

type AnyRow = Record<string, unknown>

/** 规范化标量，保证指纹不受 number/string 细微表示影响 */
function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return String(value).trim()
}

/** 行指纹：业务字段按固定顺序拼接（父引用用对齐前的原始 id，仅用于同批次内三方比对） */
export function fingerprint(row: AnyRow | null | undefined, table: BusinessTable): string {
  if (!row) return ''
  return TABLE_FIELDS[table]
    .map((field) => `${field}=${normalizeValue(row[field])}`)
    .join('|')
}

/** 从备份生成离站基线清单（id → 指纹），供调查组离站拷贝携带 */
export function buildBaseManifest(payload: BackupPayload): BaseManifest {
  const indexOf = (rows: AnyRow[], table: BusinessTable): Record<string, string> => {
    const map: Record<string, string> = {}
    rows.forEach((row) => {
      if (typeof row.id === 'string') map[row.id] = fingerprint(row, table)
    })
    return map
  }
  return {
    createdAt: payload.exportedAt ?? new Date().toISOString(),
    reefs: indexOf(payload.reefs as unknown as AnyRow[], 'reefs'),
    sites: indexOf(payload.sites as unknown as AnyRow[], 'sites'),
    belts: indexOf(payload.belts as unknown as AnyRow[], 'belts'),
    corals: indexOf(payload.corals as unknown as AnyRow[], 'corals'),
    fishes: indexOf(payload.fishes as unknown as AnyRow[], 'fishes')
  }
}

/** 两边不一致的业务字段（父引用对齐造成的差异不提示） */
function changedFields(local: AnyRow | null, incoming: AnyRow | null, table: BusinessTable, skip: string[] = []): string[] {
  if (!local || !incoming) return TABLE_FIELDS[table].filter((field) => !skip.includes(field))
  return TABLE_FIELDS[table].filter(
    (field) => !skip.includes(field) && normalizeValue(local[field]) !== normalizeValue(incoming[field])
  )
}

/** 合并结果：合并后应写入的完整五表 + 冲突清单 + 统计 */
export interface MergePlan {
  reefs: Reef[]
  sites: Site[]
  belts: Belt[]
  corals: CoralRecord[]
  fishes: FishCount[]
  conflicts: ConflictMeta[]
  stats: TableMergeStats
}

type Side = 'local' | 'incoming'

interface MatchContext {
  groupName: string
  batchId: string
  base: BaseManifest | null
  /** incoming 原始父 id → 对齐后保留的规范 id（冲突时指向调查组副本 id） */
  reefMap: Map<string, string>
  siteMap: Map<string, string>
  beltMap: Map<string, string>
  conflicts: ConflictMeta[]
  stats: TableMergeStats
  conflictSeq: number
}

/** 生成冲突号并登记元信息 */
function registerConflict(
  ctx: MatchContext,
  args: {
    table: BusinessTable
    location: string
    fields: string[]
    localRow: AnyRow
    incomingRow: AnyRow
    localId: string
    incomingId: string
  }
): string {
  ctx.conflictSeq += 1
  const conflictId = `cf_${ctx.batchId}_${String(ctx.conflictSeq).padStart(3, '0')}`
  ctx.conflicts.push({
    conflictId,
    table: args.table,
    location: args.location,
    changedFields: args.fields,
    localId: args.localId,
    incomingId: args.incomingId,
    localSource: normalizeValue(args.localRow.source) || SOURCE_STATION,
    incomingSource:
      ctx.groupName || normalizeValue(args.incomingRow.source) || SOURCE_UNKNOWN,
    resolved: false,
    winner: null,
    resolvedAt: null,
    blockedBy: []
  })
  return conflictId
}

/**
 * 三方判定：
 * - 基线存在：两边都没改 none；仅调查组改 incoming；仅主台账改 local；两边都改 both
 * - 基线缺失：两边一致 none；不一致保守判 both
 */
function classify(
  local: AnyRow | null,
  incoming: AnyRow | null,
  baseFingerprint: string | undefined,
  table: BusinessTable
): Side | 'both' | 'none' {
  if (!local || !incoming) return 'none'
  const localFp = fingerprint(local, table)
  const incomingFp = fingerprint(incoming, table)
  if (baseFingerprint === undefined) return localFp === incomingFp ? 'none' : 'both'
  const localChanged = localFp !== baseFingerprint
  const incomingChanged = incomingFp !== baseFingerprint
  if (!localChanged && !incomingChanged) return 'none'
  if (incomingChanged && !localChanged) return 'incoming'
  if (localChanged && !incomingChanged) return 'local'
  return localFp === incomingFp ? 'none' : 'both'
}

/** 调查组写入行的来源 / 批次 / 未决标记 */
function markIncoming(row: AnyRow, ctx: MatchContext, conflictId: string | null): AnyRow {
  const now = Date.now()
  return {
    ...row,
    source: ctx.groupName,
    batchId: ctx.batchId,
    pending: conflictId !== null,
    conflictId: conflictId ?? '',
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now
  }
}

/** 主台账侧行标为未决（原地修改合并集合中的行） */
function markPending(row: AnyRow, ctx: MatchContext, conflictId: string): void {
  row.source = normalizeValue(row.source) || SOURCE_STATION
  row.batchId = ctx.batchId
  row.pending = true
  row.conflictId = conflictId
  row.updatedAt = Date.now()
}

/** 接收调查组值覆盖到主台账行（沿用主台账 id 与创建时间） */
function acceptIncoming(local: AnyRow, incoming: AnyRow, ctx: MatchContext, parentPatches: Record<string, unknown>): void {
  Object.assign(local, {
    ...incoming,
    ...parentPatches,
    id: local.id,
    createdAt: local.createdAt,
    updatedAt: Date.now(),
    source: SOURCE_STATION,
    batchId: ctx.batchId,
    pending: local.pending === true,
    conflictId: local.conflictId ?? ''
  })
}

/**
 * 执行离线合并，产出写入计划（不落库，便于先预览再提交；同一输入结果确定）。
 */
export function planMerge(
  local: Pick<BackupPayload, BusinessTable>,
  incoming: BackupPayload,
  batchId: string,
  groupName: string
): MergePlan {
  const ctx: MatchContext = {
    groupName: groupName.trim() || '上岛调查组',
    batchId,
    base: incoming.base ?? null,
    reefMap: new Map(),
    siteMap: new Map(),
    beltMap: new Map(),
    conflicts: [],
    stats: createEmptyTableMergeStats(),
    conflictSeq: 0
  }

  /* -------------------------------- 礁区（按名称对齐） -------------------------------- */
  const mergedReefs: AnyRow[] = (local.reefs as unknown as AnyRow[]).map((row) => ({ ...row }))
  const localReefByName = new Map<string, AnyRow>()
  mergedReefs.forEach((row) => localReefByName.set(String(row.name ?? '').trim(), row))
  const matchedReefNames = new Set<string>()

  for (const raw of incoming.reefs as unknown as AnyRow[]) {
    const incomingRow: AnyRow = { ...raw }
    const name = String(incomingRow.name ?? '').trim()
    const localRow = name ? localReefByName.get(name) ?? null : null
    if (!localRow) {
      const added = markIncoming(incomingRow, ctx, null)
      mergedReefs.push(added)
      ctx.reefMap.set(String(incomingRow.id), String(added.id))
      ctx.stats.reefs.added += 1
      continue
    }
    matchedReefNames.add(name)
    ctx.reefMap.set(String(incomingRow.id), String(localRow.id))
    const verdict = classify(localRow, incomingRow, ctx.base?.reefs[String(incomingRow.id)], 'reefs')
    if (verdict === 'none' || verdict === 'local') {
      ctx.stats.reefs.unchanged += 1
    } else if (verdict === 'incoming') {
      acceptIncoming(localRow, incomingRow, ctx, {})
      ctx.stats.reefs.accepted += 1
    } else {
      const conflictId = registerConflict(ctx, {
        table: 'reefs',
        location: `礁区「${name}」`,
        fields: changedFields(localRow, incomingRow, 'reefs'),
        localRow,
        incomingRow,
        localId: String(localRow.id),
        incomingId: ''
      })
      markPending(localRow, ctx, conflictId)
      const copy = markIncoming({ ...incomingRow, id: createId('reef') }, ctx, conflictId)
      mergedReefs.push(copy)
      ctx.reefMap.set(String(incomingRow.id), String(copy.id))
      ctx.conflicts[ctx.conflicts.length - 1].incomingId = String(copy.id)
      ctx.stats.reefs.conflicts += 1
    }
  }
  ctx.stats.reefs.unchanged += mergedReefs.filter(
    (row) => !matchedReefNames.has(String(row.name ?? '').trim())
  ).length

  /* --------------------------- 站位（按 礁区 + 站位编号 对齐） --------------------------- */
  const mergedSites: AnyRow[] = (local.sites as unknown as AnyRow[]).map((row) => ({ ...row }))
  const localSiteIndex = new Map<string, AnyRow>()
  mergedSites.forEach((row) => localSiteIndex.set(`${String(row.reefId)}||${String(row.no ?? '').trim()}`, row))
  const matchedSiteKeys = new Set<string>()

  for (const raw of incoming.sites as unknown as AnyRow[]) {
    const incomingRow: AnyRow = { ...raw }
    const canonicalReefId = ctx.reefMap.get(String(incomingRow.reefId)) ?? String(incomingRow.reefId)
    const key = `${canonicalReefId}||${String(incomingRow.no ?? '').trim()}`
    const localRow = localSiteIndex.get(key) ?? null
    if (!localRow) {
      const added = markIncoming({ ...incomingRow, reefId: canonicalReefId }, ctx, null)
      mergedSites.push(added)
      ctx.siteMap.set(String(incomingRow.id), String(added.id))
      ctx.stats.sites.added += 1
      continue
    }
    matchedSiteKeys.add(key)
    ctx.siteMap.set(String(incomingRow.id), String(localRow.id))
    const verdict = classify(localRow, incomingRow, ctx.base?.sites[String(incomingRow.id)], 'sites')
    if (verdict === 'none' || verdict === 'local') {
      ctx.stats.sites.unchanged += 1
    } else if (verdict === 'incoming') {
      acceptIncoming(localRow, incomingRow, ctx, { reefId: canonicalReefId })
      ctx.stats.sites.accepted += 1
    } else {
      const conflictId = registerConflict(ctx, {
        table: 'sites',
        location: `站位 ${String(incomingRow.no ?? '').trim()}`,
        fields: changedFields(localRow, incomingRow, 'sites', ['reefId']),
        localRow,
        incomingRow,
        localId: String(localRow.id),
        incomingId: ''
      })
      markPending(localRow, ctx, conflictId)
      const copy = markIncoming({ ...incomingRow, id: createId('site'), reefId: canonicalReefId }, ctx, conflictId)
      mergedSites.push(copy)
      ctx.siteMap.set(String(incomingRow.id), String(copy.id))
      ctx.conflicts[ctx.conflicts.length - 1].incomingId = String(copy.id)
      ctx.stats.sites.conflicts += 1
    }
  }
  ctx.stats.sites.unchanged += mergedSites.filter((row) => {
    const key = `${String(row.reefId)}||${String(row.no ?? '').trim()}`
    return !matchedSiteKeys.has(key)
  }).length

  /* --------------------------- 样带（按 站位 + 样带编号 对齐） --------------------------- */
  const mergedBelts: AnyRow[] = (local.belts as unknown as AnyRow[]).map((row) => ({ ...row }))
  const localBeltIndex = new Map<string, AnyRow>()
  mergedBelts.forEach((row) => localBeltIndex.set(`${String(row.siteId)}||${String(row.no ?? '').trim()}`, row))
  const matchedBeltKeys = new Set<string>()

  for (const raw of incoming.belts as unknown as AnyRow[]) {
    const incomingRow: AnyRow = { ...raw }
    const canonicalSiteId = ctx.siteMap.get(String(incomingRow.siteId)) ?? String(incomingRow.siteId)
    const key = `${canonicalSiteId}||${String(incomingRow.no ?? '').trim()}`
    const localRow = localBeltIndex.get(key) ?? null
    if (!localRow) {
      const added = markIncoming({ ...incomingRow, siteId: canonicalSiteId }, ctx, null)
      mergedBelts.push(added)
      ctx.beltMap.set(String(incomingRow.id), String(added.id))
      ctx.stats.belts.added += 1
      continue
    }
    matchedBeltKeys.add(key)
    ctx.beltMap.set(String(incomingRow.id), String(localRow.id))
    const verdict = classify(localRow, incomingRow, ctx.base?.belts[String(incomingRow.id)], 'belts')
    if (verdict === 'none' || verdict === 'local') {
      ctx.stats.belts.unchanged += 1
    } else if (verdict === 'incoming') {
      acceptIncoming(localRow, incomingRow, ctx, { siteId: canonicalSiteId })
      ctx.stats.belts.accepted += 1
    } else {
      const conflictId = registerConflict(ctx, {
        table: 'belts',
        location: `样带 ${String(incomingRow.no ?? '').trim()}`,
        fields: changedFields(localRow, incomingRow, 'belts', ['siteId']),
        localRow,
        incomingRow,
        localId: String(localRow.id),
        incomingId: ''
      })
      markPending(localRow, ctx, conflictId)
      const copy = markIncoming({ ...incomingRow, id: createId('belt'), siteId: canonicalSiteId }, ctx, conflictId)
      mergedBelts.push(copy)
      ctx.beltMap.set(String(incomingRow.id), String(copy.id))
      ctx.conflicts[ctx.conflicts.length - 1].incomingId = String(copy.id)
      ctx.stats.belts.conflicts += 1
    }
  }
  ctx.stats.belts.unchanged += mergedBelts.filter((row) => {
    const key = `${String(row.siteId)}||${String(row.no ?? '').trim()}`
    return !matchedBeltKeys.has(key)
  }).length

  /* ----------------------------- 珊瑚记录 / 鱼类计数（id → 业务键补对齐） ----------------------------- */
  const mergedCorals = mergeChildren<CoralRecord>({
    table: 'corals',
    localList: local.corals,
    incomingRows: incoming.corals as unknown as CoralRecord[],
    baseIndex: ctx.base?.corals ?? {},
    ctx,
    idPrefix: 'cor',
    businessKey: (row) => `${row.beltId}||${row.genus.trim()}||${row.form}`,
    locationOf: (row) => `珊瑚「${row.genus}（${row.form}）」`
  })
  const mergedFishes = mergeChildren<FishCount>({
    table: 'fishes',
    localList: local.fishes,
    incomingRows: incoming.fishes as unknown as FishCount[],
    baseIndex: ctx.base?.fishes ?? {},
    ctx,
    idPrefix: 'fsh',
    businessKey: (row) => `${row.beltId}||${row.family.trim()}||${row.sizeClass}||${row.category}`,
    locationOf: (row) => `计数「${row.family} · ${row.sizeClass} · ${row.category}」`
  })

  fillBlockedBy(
    ctx.conflicts,
    mergedReefs,
    mergedSites,
    mergedBelts,
    mergedCorals as unknown as AnyRow[],
    mergedFishes as unknown as AnyRow[]
  )

  return {
    reefs: mergedReefs as unknown as Reef[],
    sites: mergedSites as unknown as Site[],
    belts: mergedBelts as unknown as Belt[],
    corals: mergedCorals,
    fishes: mergedFishes,
    conflicts: ctx.conflicts,
    stats: ctx.stats
  }
}

interface ChildMergeArgs<T extends { id: string; beltId: string }> {
  table: BusinessTable
  localList: T[]
  incomingRows: T[]
  baseIndex: Record<string, string>
  ctx: MatchContext
  idPrefix: string
  businessKey: (row: T) => string
  locationOf: (row: T) => string
}

function mergeChildren<T extends { id: string; beltId: string }>(args: ChildMergeArgs<T>): T[] {
  const { table, localList, incomingRows, baseIndex, ctx, idPrefix, businessKey, locationOf } = args
  const merged: AnyRow[] = localList.map((row) => ({ ...(row as unknown as AnyRow) }))

  const localById = new Map<string, AnyRow>()
  merged.forEach((row) => localById.set(String(row.id), row))
  // 业务键 → 行；仅在规范样带内唯一时才用于补对齐
  const localByKey = new Map<string, AnyRow[]>()
  merged.forEach((row) => {
    const key = businessKey({ ...(row as unknown as T) })
    const bucket = localByKey.get(key) ?? []
    bucket.push(row)
    localByKey.set(key, bucket)
  })
  const matchedIds = new Set<string>()

  for (const raw of incomingRows) {
    const incomingRow: AnyRow = { ...(raw as unknown as AnyRow) }
    incomingRow.beltId = ctx.beltMap.get(String(raw.beltId)) ?? String(raw.beltId)

    let localRow: AnyRow | null = localById.get(String(raw.id)) ?? null
    if (!localRow) {
      const candidates = (localByKey.get(businessKey(incomingRow as unknown as T)) ?? []).filter(
        (row) => !matchedIds.has(String(row.id)) && String(row.beltId) === String(incomingRow.beltId)
      )
      if (candidates.length === 1) localRow = candidates[0]
    }

    if (!localRow) {
      merged.push(markIncoming(incomingRow, ctx, null))
      ctx.stats[table].added += 1
      continue
    }
    matchedIds.add(String(localRow.id))
    const verdict = classify(localRow, incomingRow, baseIndex[String(raw.id)], table)
    if (verdict === 'none' || verdict === 'local') {
      ctx.stats[table].unchanged += 1
    } else if (verdict === 'incoming') {
      acceptIncoming(localRow, incomingRow, ctx, { beltId: String(incomingRow.beltId) })
      ctx.stats[table].accepted += 1
    } else {
      const conflictId = registerConflict(ctx, {
        table,
        location: locationOf(incomingRow as unknown as T),
        fields: changedFields(localRow, incomingRow, table, ['beltId']),
        localRow,
        incomingRow,
        localId: String(localRow.id),
        incomingId: ''
      })
      markPending(localRow, ctx, conflictId)
      const copy = markIncoming({ ...incomingRow, id: createId(idPrefix) }, ctx, conflictId)
      merged.push(copy)
      ctx.conflicts[ctx.conflicts.length - 1].incomingId = String(copy.id)
      ctx.stats[table].conflicts += 1
    }
  }
  ctx.stats[table].unchanged += merged.filter((row) => !matchedIds.has(String(row.id))).length

  return merged as unknown as T[]
}

/**
 * 回填冲突 blockedBy：父记录（礁区/站位/样带）本身未决时，
 * 提示其下明细冲突「父级也在待选」（允许先选父级，选定时自动级联处理）。
 */
function fillBlockedBy(
  conflicts: ConflictMeta[],
  reefs: AnyRow[],
  sites: AnyRow[],
  belts: AnyRow[],
  corals: AnyRow[],
  fishes: AnyRow[]
): void {
  const conflictByTableId = new Map<string, ConflictMeta>()
  conflicts.forEach((conflict) => {
    conflictByTableId.set(`${conflict.table}:${conflict.localId}`, conflict)
  })
  const siteReef = new Map(sites.map((row) => [String(row.id), String(row.reefId)]))
  const beltSite = new Map(belts.map((row) => [String(row.id), String(row.siteId)]))

  const parentConflictIds = (table: BusinessTable, localId: string): string[] => {
    const ids = new Set<string>()
    const addParent = (parentTable: BusinessTable, parentId: string | undefined) => {
      if (!parentId) return
      const parent = conflictByTableId.get(`${parentTable}:${parentId}`)
      if (parent && !parent.resolved) ids.add(parent.conflictId)
    }
    if (table === 'sites') {
      const site = sites.find((row) => String(row.id) === localId)
      addParent('reefs', site ? String(site.reefId) : undefined)
    } else if (table === 'belts') {
      const belt = belts.find((row) => String(row.id) === localId)
      const siteId = belt ? String(belt.siteId) : undefined
      addParent('sites', siteId)
      if (siteId) addParent('reefs', siteReef.get(siteId))
    } else if (table === 'corals' || table === 'fishes') {
      const rows = table === 'corals' ? corals : fishes
      const child = rows.find((row) => String(row.id) === localId)
      const beltId = child ? String(child.beltId) : undefined
      addParent('belts', beltId)
      const siteId = beltId ? beltSite.get(beltId) : undefined
      addParent('sites', siteId)
      if (siteId) addParent('reefs', siteReef.get(siteId))
    }
    return Array.from(ids)
  }

  conflicts.forEach((conflict) => {
    conflict.blockedBy = parentConflictIds(conflict.table, conflict.localId)
  })
}

/** 合并统计合计 */
export function sumStats(stats: TableMergeStats): MergeStats {
  return (Object.keys(stats) as BusinessTable[]).reduce<MergeStats>(
    (total, key) => ({
      added: total.added + stats[key].added,
      accepted: total.accepted + stats[key].accepted,
      unchanged: total.unchanged + stats[key].unchanged,
      conflicts: total.conflicts + stats[key].conflicts
    }),
    { added: 0, accepted: 0, unchanged: 0, conflicts: 0 }
  )
}

/** 合并计划中各表待决记录数（预览用） */
export function planPendingCounts(plan: MergePlan): Record<BusinessTable, number> {
  const pendingOf = (rows: Array<{ pending?: boolean }>) => rows.filter((row) => row.pending === true).length
  return {
    reefs: pendingOf(plan.reefs),
    sites: pendingOf(plan.sites),
    belts: pendingOf(plan.belts),
    corals: pendingOf(plan.corals),
    fishes: pendingOf(plan.fishes)
  }
}
