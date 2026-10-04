/**
 * 备份导入导出：整库 JSON 快照的组装、校验、下载与导入；
 * 以及按礁区/站位汇总的覆盖度结论生成。
 */
import {
  db,
  DB_NAME,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  MASTER_BATCH_ID,
  type BackupPayload
} from '@/utils/db'
import {
  BLEACH_LEVELS,
  type BleachLevel
} from '@/types/coralRecord'
import { bleachGrade, bleachIndex, bleachedSharePct, coralCoveragePct, fishDensity, round } from '@/utils/bleach'
import {
  asRows,
  baseFromRow,
  businessHash,
  contextFrom,
  normalizeProvenance
} from '@/utils/merge'
import type { MergeBase } from '@/types/merge'
import { SOURCE_MASTER } from '@/types/merge'

/** 备份集合键名 */
export const BACKUP_KEYS = ['reefs', 'sites', 'belts', 'corals', 'fishes'] as const
export type BackupKey = (typeof BACKUP_KEYS)[number]

export type CountMap = Record<BackupKey, number>

/** 合并留痕三张表（导出 / 覆盖导入共用） */
const MERGE_TABLE_KEYS = ['mergeBatches', 'mergeConflicts', 'mergeBases'] as const
export type MergeTableKey = (typeof MERGE_TABLE_KEYS)[number]

/** 导出选项：导出来源与角色（站部派发带基线，离线组带回改动） */
export interface BuildBackupOptions {
  source?: string
  role?: 'station' | 'team'
}

/** 组装当前本地数据的完整快照 */
export async function buildBackupPayload(options: BuildBackupOptions = {}): Promise<BackupPayload> {
  const [reefs, sites, belts, corals, fishes, mergeBatches, mergeConflicts, mergeBases] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    db.belts.toArray(),
    db.corals.toArray(),
    db.fishes.toArray(),
    db.mergeBatches.toArray(),
    db.mergeConflicts.toArray(),
    db.mergeBases.toArray()
  ])
  const role = options.role ?? 'station'
  const source = options.source?.trim() || (role === 'station' ? SOURCE_MASTER : '离线组')

  // 站部导出时以当前已确认台账重建派发基线（三方合并基准）；
  // 离线组导出沿用随备份带走的基线，保证回到站部仍可判定「谁改过」。
  let bases: MergeBase[] = mergeBases
  if (role === 'station') {
    const now = Date.now()
    const ctx = contextFrom({ reefs, sites, belts })
    const confirmed = {
      reefs: reefs.filter((row) => row.mergeStatus === 'confirmed'),
      sites: sites.filter((row) => row.mergeStatus === 'confirmed'),
      belts: belts.filter((row) => row.mergeStatus === 'confirmed'),
      corals: corals.filter((row) => row.mergeStatus === 'confirmed'),
      fishes: fishes.filter((row) => row.mergeStatus === 'confirmed')
    }
    bases = [
      ...confirmed.reefs.map((row) => baseFromRow('reefs', row as unknown as Record<string, unknown>, ctx, now)),
      ...confirmed.sites.map((row) => baseFromRow('sites', row as unknown as Record<string, unknown>, ctx, now)),
      ...confirmed.belts.map((row) => baseFromRow('belts', row as unknown as Record<string, unknown>, ctx, now)),
      ...confirmed.corals.map((row) => baseFromRow('corals', row as unknown as Record<string, unknown>, ctx, now)),
      ...confirmed.fishes.map((row) => baseFromRow('fishes', row as unknown as Record<string, unknown>, ctx, now))
    ]
  }

  return {
    app: 'gbcoralbelt',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    source,
    role,
    reefs,
    sites,
    belts,
    corals,
    fishes,
    // 导出的备份同时带上批次、来源和未决状态，换机可恢复后接着处理
    mergeBatches,
    mergeConflicts,
    mergeBases: bases
  }
}

/** 校验外部 JSON 是否为本站可识别的备份文件（v2 旧备份自动补默认值） */
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
  const fallbackSource = typeof obj.source === 'string' && obj.source.trim() ? obj.source : SOURCE_MASTER
  const normalized = normalizeProvenance(
    {
      reefs: obj.reefs ?? [],
      sites: obj.sites ?? [],
      belts: obj.belts ?? [],
      corals: obj.corals ?? [],
      fishes: obj.fishes ?? []
    },
    fallbackSource
  )
  const payload: BackupPayload = {
    app: 'gbcoralbelt',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    source: fallbackSource,
    role: obj.role === 'team' ? 'team' : 'station',
    ...normalized,
    mergeBatches: Array.isArray(obj.mergeBatches) ? obj.mergeBatches : [],
    mergeConflicts: Array.isArray(obj.mergeConflicts) ? obj.mergeConflicts : [],
    mergeBases: Array.isArray(obj.mergeBases) ? obj.mergeBases : []
  }
  return { ok: true, errors, payload }
}

/** 统计快照各表行数（只统计已确认记录，未决差异不计入台账规模） */
export function countPayload(payload: BackupPayload): CountMap {
  return {
    reefs: payload.reefs.filter((row) => row.mergeStatus !== 'pending').length,
    sites: payload.sites.filter((row) => row.mergeStatus !== 'pending').length,
    belts: payload.belts.filter((row) => row.mergeStatus !== 'pending').length,
    corals: payload.corals.filter((row) => row.mergeStatus !== 'pending').length,
    fishes: payload.fishes.filter((row) => row.mergeStatus !== 'pending').length
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(options: BuildBackupOptions = {}): Promise<{
  fileName: string
  counts: CountMap
  source: string
}> {
  const payload = await buildBackupPayload(options)
  const roleTag = payload.role === 'station' ? 'station' : 'team'
  const safeSource = payload.source.replace(/[\\/:*?"<>|\s]+/g, '_')
  const fileName = `${DB_NAME}-backup-${roleTag}-${safeSource}-v${payload.dbVersion}-${payload.exportedAt
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
  return { fileName, counts: countPayload(payload), source: payload.source }
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
 * 导入快照：overwrite=true 先清空全部表（含合并留痕与基线），否则按主键合并。
 * 覆盖导入同时恢复备份携带的批次 / 待决差异 / 派发基线，保证换机可接着处理。
 */
export async function importBackup(payload: BackupPayload, overwrite: boolean): Promise<CountMap> {
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.reefs, db.sites, db.belts, db.corals, db.fishes, db.mergeBatches, db.mergeConflicts, db.mergeBases],
    async () => {
      await db.reefs.bulkPut(payload.reefs)
      await db.sites.bulkPut(payload.sites)
      await db.belts.bulkPut(payload.belts)
      await db.corals.bulkPut(payload.corals)
      await db.fishes.bulkPut(payload.fishes)
      if (overwrite) {
        await db.mergeBatches.bulkPut(payload.mergeBatches)
        await db.mergeConflicts.bulkPut(payload.mergeConflicts)
        // 外来备份基线合并进本机基线表（同 id 覆盖）
        if (payload.mergeBases.length > 0) await db.mergeBases.bulkPut(payload.mergeBases)
      }
    }
  )
  return countPayload(payload)
}

/**
 * 追加式导入：为导入数据重新分配 id，避免覆盖现有档案。
 * originId 保留原始主键血缘；外键随新 id 重映射。
 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const reefMap = new Map<string, string>()
  const siteMap = new Map<string, string>()
  const beltMap = new Map<string, string>()

  const reefs = payload.reefs.map((reef) => {
    const id = createId('reef')
    reefMap.set(reef.id, id)
    return { ...reef, id, originId: reef.originId || reef.id, mergeStatus: 'confirmed' as const, conflictId: null }
  })
  const sites = payload.sites.map((site) => {
    const id = createId('site')
    siteMap.set(site.id, id)
    return {
      ...site,
      id,
      reefId: reefMap.get(site.reefId) ?? site.reefId,
      originId: site.originId || site.id,
      mergeStatus: 'confirmed' as const,
      conflictId: null
    }
  })
  const belts = payload.belts.map((belt) => {
    const id = createId('belt')
    beltMap.set(belt.id, id)
    return {
      ...belt,
      id,
      siteId: siteMap.get(belt.siteId) ?? belt.siteId,
      originId: belt.originId || belt.id,
      mergeStatus: 'confirmed' as const,
      conflictId: null
    }
  })
  const corals = payload.corals.map((coral) => ({
    ...coral,
    id: createId('cor'),
    beltId: beltMap.get(coral.beltId) ?? coral.beltId,
    originId: coral.originId || coral.id,
    mergeStatus: 'confirmed' as const,
    conflictId: null
  }))
  const fishes = payload.fishes.map((fish) => ({
    ...fish,
    id: createId('fsh'),
    beltId: beltMap.get(fish.beltId) ?? fish.beltId,
    originId: fish.originId || fish.id,
    mergeStatus: 'confirmed' as const,
    conflictId: null
  }))
  // 追加导入是另起台账，不携带原批次 / 待决状态
  return {
    ...payload,
    reefs,
    sites,
    belts,
    corals,
    fishes,
    mergeBatches: [],
    mergeConflicts: [],
    mergeBases: [],
    role: 'station',
    source: SOURCE_MASTER
  }
}

/** 站部基线表的实体主键常量（供合并模块读写） */
export { MASTER_BATCH_ID }

/** 供合并模块快速按表读取（避免循环依赖时直接触 db） */
export function mergeTableRows(key: MergeTableKey): Promise<unknown[]> {
  return db[key].toArray()
}

/** 业务字段哈希（便捷转出，供 store 决议后重建基线） */
export { asRows, businessHash }

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

/** 按样带生成覆盖度结论行（待决差异在选定前不进入覆盖度汇总） */
export function buildCoverageLines(payload: BackupPayload): CoverageLine[] {
  const reefById = new Map(
    payload.reefs.filter((reef) => reef.mergeStatus !== 'pending').map((reef) => [reef.id, reef])
  )
  const siteById = new Map(
    payload.sites.filter((site) => site.mergeStatus !== 'pending').map((site) => [site.id, site])
  )
  const confirmedBelts = payload.belts.filter((belt) => belt.mergeStatus !== 'pending')
  const pendingBeltIds = new Set(
    payload.belts.filter((belt) => belt.mergeStatus === 'pending').map((belt) => belt.id)
  )
  const coralsByBelt = new Map<string, typeof payload.corals>()
  payload.corals
    .filter((coral) => coral.mergeStatus !== 'pending' && !pendingBeltIds.has(coral.beltId))
    .forEach((coral) => {
      const list = coralsByBelt.get(coral.beltId) ?? []
      list.push(coral)
      coralsByBelt.set(coral.beltId, list)
    })
  const fishesByBelt = new Map<string, typeof payload.fishes>()
  payload.fishes
    .filter((fish) => fish.mergeStatus !== 'pending' && !pendingBeltIds.has(fish.beltId))
    .forEach((fish) => {
      const list = fishesByBelt.get(fish.beltId) ?? []
      list.push(fish)
      fishesByBelt.set(fish.beltId, list)
    })

  return confirmedBelts
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
  return payload.reefs
    .filter((reef) => reef.mergeStatus !== 'pending')
    .map((reef) => {
    const siteIds = new Set(
      payload.sites
        .filter((site) => site.mergeStatus !== 'pending' && site.reefId === reef.id)
        .map((site) => site.id)
    )
    const pendingSites = new Set(
      payload.sites.filter((site) => site.mergeStatus === 'pending').map((site) => site.id)
    )
    const beltIds = new Set(
      payload.belts
        .filter(
          (belt) =>
            belt.mergeStatus !== 'pending' &&
            siteIds.has(belt.siteId) &&
            !pendingSites.has(belt.siteId)
        )
        .map((belt) => belt.id)
    )
    const corals = payload.corals.filter(
      (coral) => coral.mergeStatus !== 'pending' && beltIds.has(coral.beltId)
    )
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
      fishTotal: payload.fishes
        .filter((fish) => fish.mergeStatus !== 'pending' && beltIds.has(fish.beltId))
        .reduce((sum, fish) => sum + fish.count, 0)
    }
  })
}
