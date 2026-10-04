/**
 * 离线合并领域类型：两组普查员分头上岛、回到站部后把离线备份并入主台账。
 *
 * 合并口径：
 * - 礁区按名称、站位按「礁区 + 编号」、样带按「站位 + 编号」对齐；
 *   珊瑚 / 鱼类记录按主键对齐，主键缺失时退化为「样带 + 属名/科名 + 形态/体长段」自然键。
 * - 仅一边改过（另一边与派发基线一致）时直接接收；两边都改过则保留两份、标记来源进入待决队列。
 * - 待决记录带 mergeStatus='pending'，选定前不进入覆盖度汇总。
 * - 失败批次与已接收内容、待决差异一并落库，可稍后重试或放弃后重新处理。
 */
import type { BackupKey } from '@/utils/export'
import type { Reef } from '@/types/reef'
import type { Site } from '@/types/site'
import type { Belt } from '@/types/belt'
import type { CoralRecord } from '@/types/coralRecord'
import type { FishCount } from '@/types/fishCount'

/** 站部主台账来源标识 */
export const SOURCE_MASTER = '站部主台账'

/** 合并批次状态 */
export type MergeBatchStatus = 'processing' | 'pending' | 'resolved' | 'failed'

/** 记录的合并状态：confirmed 进入台账与汇总，pending 为待决差异 */
export type MergeStatus = 'confirmed' | 'pending'

/** 五张业务表的联合实体名 */
export type MergeEntityName = BackupKey

/** 一条业务字段的两边取值差异 */
export interface FieldDiff {
  field: string
  label: string
  base: string | null
  local: string | null
  incoming: string | null
}

/** 合并对齐结果 */
export type MergeOutcome =
  | 'identical'
  | 'add-incoming'
  | 'update-local'
  | 'take-local'
  | 'take-incoming'
  | 'conflict'
  | 'orphan'

/** 待决差异（冲突）：两边都改过的同一条记录保留两份 */
export interface MergeConflict {
  id: string
  batchId: string
  entity: MergeEntityName
  /** 对齐用的自然键，如 礁区名 / 站位编号 / 样带编号 / 属名+形态 */
  alignKey: string
  /** 层级路径，如 清澜湾珊瑚礁区 / S-01 / T-01 */
  path: string
  /** 站部（本地）记录快照；仅一边存在时可能为 null */
  localRecord: Record<string, unknown> | null
  /** 离线组（外来）记录快照；仅一边存在时可能为 null */
  incomingRecord: Record<string, unknown> | null
  /** 派发基线快照（三方合并用，可能缺失——旧备份） */
  baseRecord: Record<string, unknown> | null
  diffs: FieldDiff[]
  status: MergeStatus
  createdAt: number
  updatedAt: number
  resolvedAt: number | null
  /** 决议：保留站部 / 接收离线组 / 两份都留 */
  resolution: 'local' | 'incoming' | 'both' | null
}

/** 合并批次：一次离线备份导入的全过程记录，失败也留在本机可恢复 */
export interface MergeBatch {
  id: string
  /** 批次号（人类可读） */
  no: string
  /** 离线来源，如 甲组 / 乙组 */
  source: string
  fileName: string
  status: MergeBatchStatus
  payload: unknown
  /** 各表接收 / 待决 / 跳过统计 */
  stats: Record<MergeEntityName, { accepted: number; conflicts: number; identical: number }>
  totalConflicts: number
  resolvedConflicts: number
  error: string
  createdAt: number
  updatedAt: number
  appliedAt: number | null
  resolvedAt: number | null
}

/** 派发基线：站部发出的基准快照哈希，供三方合并判定「哪一边改过」 */
export interface MergeBase {
  id: string
  entity: MergeEntityName
  /** 自然键（站点重命名后仍可对齐） */
  naturalKey: string
  /** 派发血缘主键（自然键失配时兜底对齐） */
  originId?: string
  /** 业务字段快照哈希 */
  hash: string
  /** 基线记录全文（冲突页展示基线取值） */
  record: Record<string, unknown>
  updatedAt: number
}

/** 一条对齐后的合并动作（计划阶段产物，不落库） */
export interface MergeItem {
  entity: MergeEntityName
  outcome: MergeOutcome
  alignKey: string
  path: string
  localId: string | null
  incomingId: string | null
  /** 待落库的本地写入行（update/add/take） */
  localRow?: Record<string, unknown>
  /** 冲突时待落库的外来副本（pending） */
  incomingRow?: Record<string, unknown>
  baseRow?: Record<string, unknown> | null
  diffs?: FieldDiff[]
}

export interface MergePlan {
  items: MergeItem[]
  conflicts: Array<Pick<MergeConflict, 'entity' | 'alignKey' | 'path' | 'localRecord' | 'incomingRecord' | 'baseRecord' | 'diffs'>>
  stats: Record<MergeEntityName, { accepted: number; conflicts: number; identical: number }>
  /** 基线缺失、退化为「两边不同即待决」的保守处理条数 */
  baseMissing: number
  orphans: Array<{ entity: MergeEntityName; message: string }>
}

/** 五张业务表的联合实体 */
export type AnyEntity = Reef | Site | Belt | CoralRecord | FishCount

/** 带来源 / 批次 / 合并状态标记的实体公共字段（各实体 interface 内同名同义） */
export interface MergeProvenanceFields {
  /** 来源：站部主台账 / 甲组 / 乙组 … */
  source: string
  /** 最后写入它的合并批次 id（站部直接录入为主台账空批次标记 '-'） */
  batchId: string
  /** 合并状态：confirmed 进汇总，pending 为待决副本 */
  mergeStatus: MergeStatus
  /** 待决时关联的 MergeConflict id */
  conflictId: string | null
  /** 派发血缘主键：离线组改的是哪条站部记录（自然对齐的桥梁） */
  originId: string
}

/** 导出备份头部的合并元信息 */
export interface BackupProvenance {
  /** 导出来源 */
  source: string
  /** 导出方角色：站部导出携带基线供离线组带走，离线组导出带回改动 */
  role: 'station' | 'team'
  exportedAt: string
  /** 待决差异快照（便于换机继续处理） */
  mergeBatches: MergeBatch[]
  mergeConflicts: MergeConflict[]
  /** 派发基线哈希表 */
  mergeBases: MergeBase[]
}
