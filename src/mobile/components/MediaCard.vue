<script setup lang="ts">
/**
 * 通用封面卡片：歌单 / 专辑 / 歌手 / 榜单 / 推荐位都复用它。
 *
 * 触屏与桌面的差别都在这里收口：
 * · 没有 hover 放大 —— 用 `:active` 的瞬时缩放给反馈
 * · 整卡可点，不给小热区
 * · 标题两行截断、副标题一行截断：窄屏下标题长度差异极大，
 *   不截断会让栅格高度参差不齐（看起来像布局坏了）
 */
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { iconMusic } from '@mobile/icons';

const props = withDefaults(
  defineProps<{
    cover?: string;
    title: string;
    subtitle?: string;
    /** 歌手头像那种圆形封面 */
    round?: boolean;
    /** 封面右下角的角标（如歌单曲目数、专辑年份） */
    badge?: string;
  }>(),
  { cover: '', subtitle: '', round: false, badge: '' },
);

const emit = defineEmits<{ select: [] }>();

const failed = ref(false);
const showCover = computed(() => Boolean(props.cover) && !failed.value);

// 卡片被复用时（同一个 v-for 里换了数据）要重置失败标记，
// 否则新条目会沿用上一个条目的"封面加载失败"状态而一直显示占位图
watch(
  () => props.cover,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <button type="button" class="media-card" @click="emit('select')">
    <span class="card-cover" :class="{ 'is-round': round }">
      <img
        v-if="showCover"
        :src="cover"
        alt=""
        loading="lazy"
        @error="failed = true"
      />
      <Icon v-else :icon="iconMusic" width="22" height="22" class="cover-fallback" />
      <span v-if="badge" class="card-badge">{{ badge }}</span>
    </span>
    <span class="card-title clamp-2">{{ title }}</span>
    <span v-if="subtitle" class="card-subtitle ellipsis">{{ subtitle }}</span>
  </button>
</template>

<style scoped>
.media-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  width: 100%;
  text-align: left;
  transition: transform var(--duration-fast) var(--ease-standard);
}

.media-card:active {
  transform: scale(0.97);
}

.card-cover {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--fill-muted);
  color: var(--text-tertiary);
}

.card-cover.is-round {
  border-radius: 50%;
}

.card-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.card-badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: rgba(0, 0, 0, 0.6);
  font-size: 10px;
  line-height: 16px;
  color: #fff;
  font-variant-numeric: tabular-nums;
}

.card-title {
  font-size: var(--font-md);
  line-height: 1.35;
  color: var(--text-primary);
}

.card-subtitle {
  font-size: var(--font-xs);
  color: var(--text-secondary);
}
</style>
