<script setup lang="ts">
/**
 * <ConflictReviewPanel> 离线合并待选差异面板：
 * 同一条记录两边都改 → 保留两份并标注来源；逐条「采用主台账 / 采用调查组」，
 * 父级未决时提示先处理上层，支持批量同侧选定。未决行选定前不进入覆盖度汇总。
 */
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, CircleCheck, Warning } from '@element-plus/icons-vue'
import BleachTag from '@/components/common/BleachTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import type { SyncBatch } from '@/types/sync'
import { useSyncStore } from '@/stores/syncStore'
import { FIELD_LABELS, TABLE_FIELDS, type BusinessTable } from '@/utils/merge'
import type { ConflictViewRow } from '@/utils/syncService'

const props = defineProps<{ batch: SyncBatch }>()
const emit = defineEmits<{ (event: 'changed'): void }>()

const syncStore = useSyncStore()
const views = ref<ConflictViewRow[]>([])
const loading = ref(false)
const tableFilter = ref<BusinessTable | 'all'>('all')

async function reload(): Promise<void> {
  loading.value = true
  try {
    views.value = await syncStore.conflictViews(props.batch)
  } finally {
    loading.value = false
  }
}
watch(() => props.batch.id, reload, { immediate: true })

const tableOptions = computed(() => {
  const present = new Set(views.value.map((view) => view.table))
  const options: Array<{ value: BusinessTable | 'all'; label: string; count: number }> = [
    { value: 'all', label: '全部', count: views.value.length }
  ]
  ;(['reefs', 'sites', 'belts', 'corals', 'fishes'] as BusinessTable[]).forEach((table) => {
    if (present.has(table)) {
      options.push({
        value: table,
        label: { reefs: '礁区', sites: '站位', belts: '样带', corals: '珊瑚记录', fishes: '鱼类计数' }[table],
        count: views.value.filter((view) => view.table === table).length
      })
    }
  })
  return options
})

const visibleViews = computed(() =>
  tableFilter.value === 'all'
    ? views.value
    : views.value.filter((view) => view.table === tableFilter.value)
)

const openCount = computed(() => views.value.filter((view) => !view.resolved).length)
const resolvedCount = computed(() => views.value.length - openCount.value)

/** 字段值人类可读（经纬度 / 白化等级 / 布尔等） */
function displayValue(view: ConflictViewRow, field: string, side: 'local' | 'incoming'): string {
  const row = side === 'local' ? view.localRow : view.incomingRow
  if (!row) return '（该侧记录已不存在）'
  const value = row[field]
  if (value === undefined || value === null || value === '') return '—'
  if (field === 'bleachLevel') return String(value)
  if (field === 'areaKm2') return `${value} km²`
  if (field === 'depthM') return `${value} m`
  if (field === 'lengthM') return `${value} m`
  if (field === 'coverCm') return `${value} cm`
  if (field === 'lat' || field === 'lng') return String(value)
  return String(value)
}

function sourceTag(view: ConflictViewRow, side: 'local' | 'incoming'): string {
  return side === 'local' ? view.localSource : view.incomingSource
}

function compareFields(view: ConflictViewRow): string[] {
  // 已删侧 / 新增侧：显示全部业务字段；否则只显示改动字段
  if (!view.localRow || !view.incomingRow) return TABLE_FIELDS[view.table]
  return view.changedFields.length > 0 ? view.changedFields : TABLE_FIELDS[view.table]
}

function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field
}

function isBleachField(field: string): boolean {
  return field === 'bleachLevel'
}

async function choose(view: ConflictViewRow, winner: 'local' | 'incoming'): Promise<void> {
  if (view.resolved) return
  await syncStore.resolve(props.batch.id, view.conflictId, winner)
  ElMessage.success(winner === 'local' ? '已采用主台账版本' : `已采用${view.incomingSource}版本`)
  await reload()
  emit('changed')
}

async function chooseAll(winner: 'local' | 'incoming'): Promise<void> {
  const label = winner === 'local' ? '全部采用主台账版本' : `全部采用${props.batch.groupName}版本`
  await syncStore.resolveAll(props.batch.id, winner)
  ElMessage.success(`${label}，待选差异已全部结案`)
  await reload()
  emit('changed')
}
</script>

<template>
  <el-card shadow="never" class="conflict-panel">
    <template #header>
      <div class="conflict-panel__head">
        <div>
          <h3>待选差异（{{ openCount }} 条未决 / {{ resolvedCount }} 条已选定）</h3>
          <p class="gb-hint">
            同一条记录两边都改过，已保留两份并标注来源。逐条选定前，这些记录<strong>不进入覆盖度汇总</strong>；
            选择父级（礁区/站位/样带）时会自动级联处理其下同源副本。
          </p>
        </div>
        <div v-if="openCount > 0" class="conflict-panel__bulk">
          <el-button size="small" :icon="CircleCheck" @click="chooseAll('local')">全部采用主台账</el-button>
          <el-button size="small" type="primary" plain :icon="Check" @click="chooseAll('incoming')">
            全部采用{{ batch.groupName }}
          </el-button>
        </div>
      </div>
    </template>

    <div v-loading="loading">
      <EmptyPanel
        v-if="views.length === 0"
        title="没有待选差异"
        description="该批次没有两边都改过的记录，调查组内容已全部直接接收并进入覆盖度汇总。"
        compact
      />

      <template v-else>
        <el-radio-group v-model="tableFilter" size="small" class="conflict-panel__filter">
          <el-radio-button v-for="option in tableOptions" :key="option.value" :value="option.value">
            {{ option.label }}（{{ option.count }}）
          </el-radio-button>
        </el-radio-group>

        <div class="conflict-list">
          <div
            v-for="view in visibleViews"
            :key="view.conflictId"
            class="conflict-card"
            :class="{ 'is-resolved': view.resolved }"
          >
            <div class="conflict-card__title">
              <el-tag size="small" type="info" effect="plain">{{ view.tableLabel }}</el-tag>
              <span>{{ view.location }}</span>
              <el-tag v-if="view.resolved" size="small" type="success">已选定 · {{ view.winner === 'local' ? '主台账' : view.incomingSource }}</el-tag>
              <el-tag v-else size="small" type="warning" :icon="Warning">未决</el-tag>
              <span v-if="view.blockedBy.length > 0 && !view.resolved" class="gb-hint">
                上级（{{ view.blockedBy.length }} 项）也在待选，选定上级会级联处理
              </span>
            </div>

            <div class="conflict-card__sides">
              <div class="conflict-side" :class="{ 'is-winner': view.resolved && view.winner === 'local' }">
                <div class="conflict-side__head">
                  <el-tag size="small" type="success" effect="dark">主台账</el-tag>
                  <span class="conflict-side__source">{{ sourceTag(view, 'local') }}</span>
                </div>
                <dl class="conflict-side__fields">
                  <template v-for="field in compareFields(view)" :key="`local-${field}`">
                    <dt>{{ fieldLabel(field) }}</dt>
                    <dd>
                      <BleachTag v-if="isBleachField(field) && view.localRow?.[field]" :level="view.localRow[field] as never" size="small" :plain="true" />
                      <span v-else :class="{ 'conflict-side__missing': !view.localRow }">{{ displayValue(view, field, 'local') }}</span>
                    </dd>
                  </template>
                </dl>
              </div>

              <div class="conflict-side" :class="{ 'is-winner': view.resolved && view.winner === 'incoming' }">
                <div class="conflict-side__head">
                  <el-tag size="small" type="warning" effect="dark">调查组</el-tag>
                  <span class="conflict-side__source">{{ sourceTag(view, 'incoming') }}</span>
                </div>
                <dl class="conflict-side__fields">
                  <template v-for="field in compareFields(view)" :key="`incoming-${field}`">
                    <dt>{{ fieldLabel(field) }}</dt>
                    <dd>
                      <BleachTag v-if="isBleachField(field) && view.incomingRow?.[field]" :level="view.incomingRow[field] as never" size="small" :plain="true" />
                      <span v-else :class="{ 'conflict-side__missing': !view.incomingRow }">{{ displayValue(view, field, 'incoming') }}</span>
                    </dd>
                  </template>
                </dl>
              </div>
            </div>

            <div v-if="!view.resolved" class="conflict-card__actions">
              <el-button size="small" @click="choose(view, 'local')">采用主台账版本</el-button>
              <el-button size="small" type="primary" @click="choose(view, 'incoming')">
                采用{{ view.incomingSource }}版本
              </el-button>
            </div>
          </div>
        </div>
      </template>
    </div>
  </el-card>
</template>

<style scoped>
.conflict-panel__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.conflict-panel__head h3 {
  margin: 0 0 4px;
  color: #0b5d5a;
}

.conflict-panel__bulk {
  display: flex;
  gap: 8px;
}

.conflict-panel__filter {
  margin: 4px 0 12px;
}

.conflict-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.conflict-card {
  border: 1px solid #d8e8e5;
  border-radius: 10px;
  padding: 12px;
  background: #fff;
}

.conflict-card.is-resolved {
  background: #f5faf8;
  opacity: 0.85;
}

.conflict-card__title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #10312f;
  margin-bottom: 10px;
}

.conflict-card__sides {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 10px;
}

.conflict-side {
  border: 1px solid #e2ecea;
  border-radius: 8px;
  padding: 10px;
  background: #fbfdfc;
}

.conflict-side.is-winner {
  border-color: #2e8b7f;
  box-shadow: inset 0 0 0 1px #2e8b7f;
}

.conflict-side__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.conflict-side__source {
  font-size: 12px;
  color: #4c6663;
}

.conflict-side__fields {
  display: grid;
  grid-template-columns: 92px 1fr;
  gap: 4px 10px;
  margin: 0;
  font-size: 13px;
}

.conflict-side__fields dt {
  color: #7c9995;
}

.conflict-side__fields dd {
  margin: 0;
  color: #10312f;
}

.conflict-side__missing {
  color: #b04a3f;
}

.conflict-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 10px;
}
</style>
