<script setup lang="ts">
/**
 * 详情页公共头部（歌单 / 专辑 / 歌手）。
 *
 * 结构对齐参考产品：大封面 + 标题 + 副标题 + 统计行 + 操作行。
 * 触屏版把桌面的「吸顶 sliver header + 滚动时收起」简化成**普通头部**：
 * 那个交互在窄屏上收益很小（屏幕本来就小，收起省不下多少），
 * 却要处理滚动阈值、封面缩放、标题位移三套联动，掉帧风险高。
 */
import { ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { iconMusic, iconPlay } from '@mobile/icons';

const props = withDefaults(
  defineProps<{
    cover?: string;
    title: string;
    subtitle?: string;
    /** 统计信息，如「1.2 万播放 · 30 首」 */
    stats?: string;
    /** 歌手用圆形封面 */
    round?: boolean;
    /** 数据来源说明（如「来自酷狗」）—— 明确告知用户数据不是我们编排的 */
    source?: string;
    /** 有歌可播时才显示「播放全部」 */
    playable?: boolean;
    playing?: boolean;
  }>(),
  {
    cover: '',
    subtitle: '',
    stats: '',
    round: false,
    source: '',
    playable: false,
    playing: false,
  },
);

const emit = defineEmits<{ playAll: [] }>();

const failed = ref(false);
watch(
  () => props.cover,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <header class="detail-header">
    <div class="head-row">
      <div class="cover" :class="{ 'is-round': round }">
        <img
          v-if="cover && !failed"
          :src="cover"
          alt=""
          loading="lazy"
          @error="failed = true"
        />
        <Icon v-else :icon="iconMusic" width="32" height="32" class="cover-fallback" />
      </div>

      <div class="head-text">
        <h1 class="title clamp-2">{{ title }}</h1>
        <p v-if="subtitle" class="subtitle ellipsis">{{ subtitle }}</p>
        <p v-if="stats" class="stats">{{ stats }}</p>
        <p v-if="source" class="source">{{ source }}</p>
      </div>
    </div>

    <button v-if="playable" type="button" class="play-all" @click="emit('playAll')">
      <Icon :icon="iconPlay" width="20" height="20" />
      <span>{{ playing ? '正在播放' : '播放全部' }}</span>
    </button>
  </header>
</template>

<style scoped>
.detail-header {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
}

.head-row {
  display: flex;
  gap: var(--sp-4);
  align-items: flex-start;
}

.cover {
  flex: 0 0 112px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 112px;
  height: 112px;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--fill-muted);
  color: var(--text-tertiary);
}

.cover.is-round {
  border-radius: 50%;
  /* 圆形头像比方形封面小一号，视觉重量才平衡 */
  flex-basis: 96px;
  width: 96px;
  height: 96px;
  margin: 8px;
}

.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.title {
  margin: 0;
  font-size: var(--font-xl);
  font-weight: var(--weight-bold);
  line-height: 1.3;
}

.subtitle {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.stats {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.source {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
  opacity: 0.8;
}

.play-all {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  height: 46px;
  border-radius: var(--radius-pill);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.play-all:active {
  background: var(--accent-pressed);
}
</style>
