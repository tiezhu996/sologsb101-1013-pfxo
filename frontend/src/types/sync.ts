/**
 * 离线合并（两组上岛 → 回站部并入主台账）相关类型。
 *
 * 合并口径：
 * - 礁区按名称对齐，站位按「所属礁区 + 站位编号」对齐，样带按「所属站位 + 样带编号」对齐；
 * - 底质/站位字段、珊瑚记录、鱼类计数只在一边改过的直接接收；
 * - 同一条记录两边都改过则保留两份，各自标注来源（source）并挂同一个冲突号（conflictId），
 *   选定前 pending=true，不进入覆盖度汇总。
 */
import type { BackupPayload } from '@/utils/db'

/** 记录来源：主台账（站部）、上岛调查组（组名/编号），历史数据无标记时按主台账处理 */
export type RecordSource = string

/** 主台账默认来源名 */
export const SOURCE_STATION = '主台账'

/** 未知来源（早期导出的备份没有来源字段） */
export const SOURCE_UNKNOWN = '未标注来源'

/** 备份用途：station 站部全量备份；group 上岛调查组离站拷贝 */
export type BackupKind = 'station' | 'group'

/** 批次处理状态 */
export type BatchStatus =
  | 'staged' // 已暂存到本机，尚未执行合并（异常中断后可恢复继续）
  | 'merged' // 已合并进主台账，仍有冲突待人工选定
  | 'resolved' // 冲突全部选定，批次结案
  | 'failed' // 合并事务失败，原批次完整保留，可重试或放弃

export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  staged: '待合并',
  merged: '待选差异',
  resolved: '已结案',
  failed: '合并失败'
}

/** 单条待选差异（冲突组）的元信息，随批次持久化，便于失败恢复后接着处理 */
export interface ConflictMeta {
  /** 冲突号：同一条两边都改时，两份记录共享 */
  conflictId: string
  /** 实体表 */
  table: keyof Omit<BackupPayload, 'app' | 'dbVersion' | 'exportedAt' | 'kind' | 'groupName' | 'base' | 'batches'>
  /** 人类可读定位：礁区名 / 站位编号 / 样带编号 / 属名 / 科名等 */
  location: string
  /** 冲突记录上改了哪些字段 */
  changedFields: string[]
  /** 主台账侧记录 id（站点本地那份） */
  localId: string
  /** 调查组侧记录 id（合并时为重复副本新分配的 id） */
  incomingId: string
  /** 主台账来源名 */
  localSource: string
  /** 调查组来源名 */
  incomingSource: string
  /** 是否已选定 */
  resolved: boolean
  /** 选定结果：local 保留主台账侧，incoming 采用调查组侧 */
  winner: 'local' | 'incoming' | null
  resolvedAt: number | null
  /** 若冲突对象是礁区/站位/样带，其下属未决冲突的冲突号（提示先解决明细） */
  blockedBy: string[]
}

/** 合并动作统计（暂存前预览、批次详情共用） */
export interface MergeStats {
  /** 调查组新增（本地没有）的记录数 */
  added: number
  /** 只在一边改过、直接接收的记录数 */
  accepted: number
  /** 两边一致、无需处理的记录数 */
  unchanged: number
  /** 两边都改、保留两份待选定的冲突组数 */
  conflicts: number
}

export type TableMergeStats = Record<'reefs' | 'sites' | 'belts' | 'corals' | 'fishes', MergeStats>

export function createEmptyTableMergeStats(): TableMergeStats {
  return {
    reefs: { added: 0, accepted: 0, unchanged: 0, conflicts: 0 },
    sites: { added: 0, accepted: 0, unchanged: 0, conflicts: 0 },
    belts: { added: 0, accepted: 0, unchanged: 0, conflicts: 0 },
    corals: { added: 0, accepted: 0, unchanged: 0, conflicts: 0 },
    fishes: { added: 0, accepted: 0, unchanged: 0, conflicts: 0 }
  }
}

/**
 * 离线合并批次：原批次文件始终随批次行完整保留在本机（payload），
 * 合并失败 / 页面关闭后都能恢复「已确认内容 + 待选差异」继续处理。
 */
export interface SyncBatch {
  /** 批次号 */
  id: string
  /** 调查组名（来源标记），如 一组 / 二组 */
  groupName: string
  /** 原始备份文件名 */
  fileName: string
  status: BatchStatus
  /** 原始批次完整内容（失败重试、放弃回滚用） */
  payload: BackupPayload
  /** 合并前主台账基线指纹（可能为空：基线信息缺失时按保守策略判冲突） */
  base: BaseManifest | null
  createdAt: number
  mergedAt: number | null
  resolvedAt: number | null
  /** 失败原因（status=failed 时） */
  lastError: string
  stats: TableMergeStats
  /** 待选差异清单（resolved 后全部 winner 非空） */
  conflicts: ConflictMeta[]
}

/** 离站拷贝携带的基线快照（全量指纹 + 行 id，用于回站三方对齐） */
export interface BaseManifest {
  createdAt: string
  reefs: Record<string, string>
  sites: Record<string, string>
  belts: Record<string, string>
  corals: Record<string, string>
  fishes: Record<string, string>
}

/** 冲突组在页面上的行视图 */
export interface ConflictView extends ConflictMeta {
  /** 表中文名 */
  tableLabel: string
  /** 主台账侧记录（可能已被人工删掉，此时为 null） */
  localRow: Record<string, unknown> | null
  /** 调查组侧记录 */
  incomingRow: Record<string, unknown> | null
  /** 下属未决冲突数 */
  blockedCount: number
}

/** 读取记录来源（历史数据无 source 字段时按主台账处理） */
export function sourceOf(row: { source?: string | null } | null | undefined): string {
  const source = row?.source?.trim()
  return source ? source : SOURCE_STATION
}
