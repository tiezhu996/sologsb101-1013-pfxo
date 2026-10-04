/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 按礁区/站位汇总的覆盖度结论生成；以及上岛调查组离站拷贝 / 回站备份的差异。
 *
 * 导出的备份统一携带：
 * - kind：station 站部台账 / group 上岛调查组离站拷贝（含 base 离站基线、groupName 来源名）；
 * - batches：本机保留的合并批次摘要与未决状态；
 * - 行级 source / batchId / pending / conflictId（随五表一起导出）。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  STATION_MARKERS,
  type BackupPayload,
  type BatchSummary
} from '@/utils/db'
import { BLEACH_LEVELS, type BleachLevel } from '@/types/coralRecord'
import type { BackupKind, BaseManifest } from '@/types/sync'
import { buildBaseManifest } from '@/utils/merge'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'

/** 备份集合键名 */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 读取行级未决标记（老数据无该字段时按 false 处理） */
export function isPending(row: { pending?: boolean } | null | undefined): boolean {
  return row?.pending === true
}

/** 组装批次摘要（syncBatches 表行 → 备份内轻量摘要） */
export async function buildBatchSummaries(): Promise<BatchSummary[]> {
  const batches = await db.syncBatches.toArray()
  const pendingByBatch: Record<string, BatchSummary['pendingCounts']> = {}
  const tables = [db.reefs, db.sites, db.belts, db.corals, db.fishes] as const
  const rowsByTable = await Promise.all(tables.map((table) => table.toArray()))
  rowsByTable.forEach((rows, tableIndex) => {
    const tableName = BACKUP_KEYS[tableIndex]
    rows.forEach((row) => {
      const batchId = (row as { batchId?: string }).batchId
      if (!batchId || !(row as { pending?: boolean }).pending) return
      const bucket = pendingByBatch[batchId] ?? { reefs: 0, sites: 0, belts: 0, corals: 0, fishes: 0 }
      bucket[tableName] += 1
      pendingByBatch[batchId] = bucket
    })
  })
  return batches
    .map((batch) => ({
      id: batch.id,
      groupName: batch.groupName,
      status: batch.status,
      fileName: batch.fileName,
      createdAt: batch.createdAt,
      mergedAt: batch.mergedAt,
      resolvedAt: batch.resolvedAt,
      conflictTotal: batch.conflicts.length,
      conflictResolved: batch.conflicts.filter((item) => item.resolved).length,
      pendingCounts: pendingByBatch[batch.id] ?? { reefs: 0, sites: 0, belts: 0, corals: 0, fishes: 0 }
    }))
    .sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 组装当前本地数据的完整快照。
 * @param kind station=站部备份（默认）；group=上岛调查组离站拷贝，携带来源名与离站基线
 */
export async function buildBackupPayload(kind: BackupKind = 'station', groupName = ''): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray()
  ])
  const exportedAt = new Date().toISOString()
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt,
    reefs,
    sites,
    belts,
    corals,
    fishes,
    kind,
    groupName: kind === 'group' ? groupName.trim() || '上岛调查组' : groupName
  }
  if (kind === 'group') {
    payload.base = buildBaseManifest(payload)
  } else {
    payload.batches = await buildBatchSummaries()
  }
  return payload
}

/** 校验外部 JSON 是否为本站可识别的备份文件 */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== undefined && obj.app !== 'gbcoralbelt') {
    errors.push('app 字段应为 gbcoralbelt，文件来源不明')
  }
  for (const key of BACKUP_KEYS) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    reefs: normalizeRows(obj.reefs ?? [], '主台账'),
    sites: normalizeRows(obj.sites ?? [], '主台账'),
    belts: normalizeRows(obj.belts ?? [], '主台账'),
    corals: normalizeRows(obj.corals ?? [], '主台账'),
    fishes: normalizeRows(obj.fishes ?? [], '主台账'),
    kind: obj.kind === 'group' ? 'group' : 'station',
    groupName: typeof obj.groupName === 'string' ? obj.groupName : '',
    base: isBaseManifest(obj.base) ? obj.base : null,
    batches: Array.isArray(obj.batches) ? obj.batches : []
  }
  return { ok: true, errors, payload }
}

function isBaseManifest(value: unknown): value is BaseManifest {
  if (typeof value !== 'object' || value === null) return false
  const manifest = value as Partial<BaseManifest>
  return ['reefs', 'sites', 'belts', 'corals', 'fishes'].every((key) => {
    const section = manifest[key as keyof BaseManifest]
    return typeof section === 'object' && section !== null
  })
}

/** 老备份行补齐来源 / 批次 / 未决字段，避免入库后参与汇总时出现 undefined */
function normalizeRows<T extends { id: string }>(rows: T[], fallbackSource: string): T[] {
  return rows.map((row) => {
    const extended = row as T & Record<string, unknown>
    return {
      ...STATION_MARKERS,
      ...extended,
      source:
        typeof extended.source === 'string' && extended.source.trim() ? extended.source : fallbackSource,
      batchId: typeof extended.batchId === 'string' ? extended.batchId : '',
      pending: extended.pending === true,
      conflictId: typeof extended.conflictId === 'string' ? extended.conflictId : ''
    } as T
  })
}

/** 统计快照各表行数 */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.length,
    sites: payload.sites.length,
    belts: payload.belts.length,
    corals: payload.corals.length,
    fishes: payload.fishes.length
  }
}

/** 导出 JSON 文件到浏览器下载目录（站部备份 / 调查组离站拷贝） */
export async function exportBackupJson(
  kind: BackupKind = 'station',
  groupName = ''
): Promise<{ fileName: string; counts: CountMap }> {
  const payload = await buildBackupPayload(kind, groupName)
  const suffix = kind === 'group' ? `group-${(groupName.trim() || 'survey').replace(/\s+/g, '-')}-` : ''
  const fileName = `${DB_NAME}-${suffix}backup-v${payload.dbVersion}-${payload.exportedAt
    .slice(0, 19)
    .replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return { fileName, counts: countPayload(payload) }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * 导入快照：
 * - overwrite=true 先清空五张业务表（离线合并批次默认保留在本机）；
 * - 追加模式重新分配 id，记录来源统一回落到主台账，避免把外部 pending 带进汇总。
 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables(false)
  const data = overwrite
    ? payload
    : {
        ...remapIds(payload),
        kind: 'station' as BackupKind,
        groupName: '',
        base: null
      }
  await db.transaction('rw', [db.reefs, db.sites, db.belts, db.corals, db.fishes], async () => {
    await db.reefs.bulkPut(data.reefs)
    await db.sites.bulkPut(data.sites)
    await db.belts.bulkPut(data.belts)
    await db.corals.bulkPut(data.corals)
    await db.fishes.bulkPut(data.fishes)
  })
  return countPayload(payload)
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

  const stripMarkers = <T extends Record<string, unknown>>(row: T): T =>
    ({ ...row, source: '主台账', batchId: '', pending: false, conflictId: '' }) as T

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return stripMarkers({ ...reef, id })
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return stripMarkers({ ...site, id, reefId: reefMap.get(site.reefId) ?? site.reefId })
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return stripMarkers({ ...belt, id, siteId: siteMap.get(belt.siteId) ?? belt.siteId })
  })
  const corals = payload.corals.map((coral) =>
    stripMarkers({
      ...coral,
      id: createId('cor'),
      beltId: beltMap.get(coral.beltId) ?? coral.beltId
    })
  )
  const fishes = payload.fishes.map((fish) =>
    stripMarkers({
      ...fish,
      id: createId('fsh'),
      beltId: beltMap.get(fish.beltId) ?? fish.beltId
    })
  )
  return { ...payload, reefs, sites, belts, corals, fishes }
}

/** 白化等级分布：各等级累计覆盖长度 */
export type BleachDistribution = Record<BleachLevel, number>

/** 覆盖度结论行：按样带汇总珊瑚覆盖率、白化占比与鱼类密度 */
export interface CoverageLine {
  beltId: string
  beltNo: string
  reefId: string
  reefName: string
  siteId: string
  siteNo: string
  lengthM: number
  orientation: string
  surveyDate: string
  observer: string
  coralCount: number
  coverCmTotal: number
  /** 珊瑚覆盖率（%） */
  coveragePct: number
  /** 白化指数 0 ~ 4 */
  bleachIndex: number
  /** 总体白化等级 */
  grade: BleachLevel
  /** 白化占比（%，覆盖长度加权） */
  bleachedSharePct: number
  distribution: BleachDistribution
  fishTotal: number
  invertebrateTotal: number
  /** 鱼类密度（尾 / 100 m²） */
  fishDensity: number
  conclusion: string
}

/** 按样带生成覆盖度结论行（未决的样带 / 珊瑚 / 鱼类记录不进入汇总） */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const activeReefs = payload.reefs.filter((reef) => !isPending(reef))
  const activeSites = payload.sites.filter((site) => !isPending(site))
  const activeBelts = payload.belts.filter((belt) => !isPending(belt))
  const activeCorals = payload.corals.filter((coral) => !isPending(coral))
  const activeFishes = payload.fishes.filter((fish) => !isPending(fish))
  const reefById = new Map(activeReefs.map((reef) => [reef.id, reef]))
  const siteById = new Map(activeSites.map((site) => [site.id, site]))
  const coralsByBelt = new Map<string, typeof activeCorals>()
  activeCorals.forEach((coral) => {
    const list = coralsByBelt.get(coral.beltId) ?? []
    list.push(coral)
    coralsByBelt.set(coral.beltId, list)
  })
  const fishesByBelt = new Map<string, typeof activeFishes>()
  activeFishes.forEach((fish) => {
    const list = fishesByBelt.get(fish.beltId) ?? []
    list.push(fish)
    fishesByBelt.set(fish.beltId, list)
  })

  return activeBelts
    .map((belt) => {
      const site = siteById.get(belt.siteId)
      const reef = site ? reefById.get(site.reefId) : undefined
      const corals = coralsByBelt.get(belt.id) ?? []
      const fishes = fishesByBelt.get(belt.id) ?? []
      const coverCmTotal = round(
        corals.reduce((sum, coral) => sum + coral.coverCm, 0),
        1
      )
      const index = bleachIndex(corals)
      const grade = bleachGrade(index)
      const distribution: BleachDistribution = { 无: 0, 轻: 0, 中: 0, 重: 0, 死亡: 0 }
      BLEACH_LEVELS.forEach((level) => {
        distribution[level] = round(
          corals.filter((coral) => coral.bleachLevel === level).reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        )
      })
      const fishTotal = fishes.filter((fish) => fish.category === '鱼类').reduce((sum, fish) => sum + fish.count, 0)
      const invertebrateTotal = fishes
        .filter((fish) => fish.category === '无脊椎动物')
        .reduce((sum, fish) => sum + fish.count, 0)
      return {
        beltId: belt.id,
        beltNo: belt.no,
        reefId: reef?.id ?? '',
        reefName: reef?.name ?? '未知礁区',
        siteId: site?.id ?? '',
        siteNo: site?.no ?? '—',
        lengthM: belt.lengthM,
        orientation: belt.orientation,
        surveyDate: belt.surveyDate,
        observer: belt.observer,
        coralCount: corals.length,
        coverCmTotal,
        coveragePct: coralCoveragePct(coverCmTotal, belt.lengthM),
        bleachIndex: index,
        grade,
        bleachedSharePct: bleachedSharePct(corals),
        distribution,
        fishTotal,
        invertebrateTotal,
        fishDensity: fishDensity(fishTotal, belt.lengthM),
        conclusion:
          corals.length === 0
            ? '该样带尚未录入珊瑚记录'
            : grade === '无'
              ? `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，未见白化`
              : `珊瑚覆盖率 ${coralCoveragePct(coverCmTotal, belt.lengthM)}%，白化指数 ${index}（${grade}），白化占比 ${bleachedSharePct(corals)}%`
      }
    })
    .sort((a, b) => b.bleachIndex - a.bleachIndex)
}

/** 按礁区汇总：站位/样带数量、平均白化指数与总体等级 */
export interface ReefSummary {
  reefId: string
  reefName: string
  protectStatus: string
  siteCount: number
  beltCount: number
  coralCount: number
  coverCmTotal: number
  avgBleachIndex: number
  grade: BleachLevel
  fishTotal: number
}

export function buildReefSummaries(payload: BackupPayload, lines: CoverageLine[]): ReefSummary[] {
  const activeSites = payload.sites.filter((site) => !isPending(site))
  const activeBelts = payload.belts.filter((belt) => !isPending(belt))
  const activeCorals = payload.corals.filter((coral) => !isPending(coral))
  const activeFishes = payload.fishes.filter((fish) => !isPending(fish))
  return payload.reefs
    .filter((reef) => !isPending(reef))
    .map((reef) => {
      const siteIds = new Set(activeSites.filter((site) => site.reefId === reef.id).map((site) => site.id))
      const beltIds = new Set(activeBelts.filter((belt) => siteIds.has(belt.siteId)).map((belt) => belt.id))
      const corals = activeCorals.filter((coral) => beltIds.has(coral.beltId))
      const lines4Reef = lines.filter((line) => line.reefId === reef.id)
      const avgBleachIndex =
        lines4Reef.length === 0
          ? 0
          : round(lines4Reef.reduce((sum, line) => sum + line.bleachIndex, 0) / lines4Reef.length, 2)
      return {
        reefId: reef.id,
        reefName: reef.name,
        protectStatus: reef.protectStatus,
        siteCount: siteIds.size,
        beltCount: beltIds.size,
        coralCount: corals.length,
        coverCmTotal: round(
          corals.reduce((sum, coral) => sum + coral.coverCm, 0),
          1
        ),
        avgBleachIndex,
        grade: bleachGrade(avgBleachIndex),
        fishTotal: activeFishes
          .filter((fish) => beltIds.has(fish.beltId))
          .reduce((sum, fish) => sum + fish.count, 0)
      }
    })
}
