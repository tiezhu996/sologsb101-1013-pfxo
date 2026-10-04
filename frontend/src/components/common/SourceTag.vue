<script setup lang="ts">
/**
 * <SourceTag> 来源 / 未决状态标记。
 * 离线合并后同一条记录两边都改过会保留两份：待决副本标橙色「待选定」并展示来源，
 * 已确认记录可按需以 plain 样式展示其来源（甲组 / 乙组 / 站部主台账）。
 * 被珊瑚计数页、鱼类计数页、样带布设页与合并中心消费。
 */
import { computed } from 'vue'
import { WarningFilled, Connection } from '@element-plus/icons-vue'
import { SOURCE_MASTER } from '@/types/merge'

const props = withDefaults(
  defineProps<{
    source?: string
    /** 合并状态：pending 为待决差异副本 */
    mergeStatus?: 'confirmed' | 'pending'
    /** 已确认记录是否也展示来源（默认仅待决时展示） */
    showConfirmedSource?: boolean
    size?: 'small' | 'default'
  }>(),
  {
    source: SOURCE_MASTER,
    mergeStatus: 'confirmed',
    showConfirmedSource: false,
    size: 'small'
  }
)

const isPending = computed(() => props.mergeStatus === 'pending')
const visible = computed(() => isPending.value || (props.showConfirmedSource && props.source && props.source !== SOURCE_MASTER))
const label = computed(() => (isPending.value ? `待选定 · ${props.source}` : props.source))
const tone = computed(() => (isPending.value ? 'warning' : 'info'))
</script>

<template>
  <el-tooltip
    v-if="visible"
    :content="isPending ? '该记录为离线合并待决差异，选定前不进入覆盖度汇总' : `数据来源：${source}`"
    placement="top"
  >
    <el-tag :type="tone" :size="size" effect="plain" class="source-tag" disable-transitions>
      <el-icon class="source-tag__icon">
        <WarningFilled v-if="isPending" />
        <Connection v-else />
      </el-icon>
      {{ label }}
    </el-tag>
  </el-tooltip>
</template>

<style scoped>
.source-tag {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.source-tag__icon {
  font-size: 12px;
}
</style>
