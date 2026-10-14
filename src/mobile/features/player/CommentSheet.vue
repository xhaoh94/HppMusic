<script setup lang="ts">
/**
 * 评论面板（只读）。
 *
 * ## 关键坑：`mixsongid` 必须是内核映射后的 `Song.mixSongId`
 *
 * 这个接口一度被认为"坏了" —— 实测响应里只有 `err_code`/`status`/`count`，
 * 没有 `list`。真实原因是 `mixsongid` 传了 `undefined`：
 * **不同来源的歌曲字段不一样**，排行榜返回的条目只有 `album_audio_id`/`audio_id`，
 * 没有 `mixsongid`；而每日推荐的条目有。所以必须用内核 `mapXxx` 映射后的
 * `Song.mixSongId`（所有 mapper 都会填这个字段），不能自己从原始响应里取。
 * 传对之后同一首歌返回 7221 条评论。
 *
 * ## 只读是有意的
 *
 * 内核 `api/comment.ts` 里只有"取"的接口（列表/楼层/数量/收藏数），
 * 没有点赞与发表。所以这里**不渲染点赞按钮、不做回复入口** ——
 * 放一个点了没反应的爱心比不显示更糟。点赞数作为信息展示保留。
 */
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import Sheet from '@mobile/components/Sheet.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { useInfiniteList } from '@mobile/composables/useInfiniteList';
import { useNowPlaying } from '@mobile/adapters/player';
import { getMusicComments } from '@/api/comment';
import { mapCommentItem } from '@/utils/mappers';
import logger from '@/utils/logger';
import { iconUser } from '@mobile/icons';
import type { Comment } from '@/models/comment';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { track } = useNowPlaying();

const PAGE_SIZE = 30;
const mixSongId = computed(() => String(track.value?.mixSongId ?? ''));
/** 接口在响应顶层给总数 */
const total = ref(0);

const list = useInfiniteList<Comment>(
  async (page) => {
    const id = mixSongId.value;
    if (!id) return { items: [], hasMore: false };
    const response: any = await getMusicComments(id, page, PAGE_SIZE);
    if (page === 1) total.value = Number(response?.count ?? 0) || 0;
    const raw = Array.isArray(response?.list) ? response.list : [];
    return { items: raw.map((item: unknown) => mapCommentItem(item)), hasMore: raw.length >= PAGE_SIZE };
  },
  // 打开面板时才加载：评论是次要内容，不该在切歌时就白白请求
  { immediate: false },
);

// 面板打开 / 切歌 → 重新加载
watch(
  () => [props.modelValue, mixSongId.value] as const,
  ([open]) => {
    if (!open) return;
    if (!mixSongId.value) {
      logger.warn('Comment', 'Current track has no mixSongId');
      return;
    }
    void list.reload();
  },
);

/** 头像加载失败时退回占位图标 */
const avatarFailed = ref<Set<string>>(new Set());
const onAvatarError = (key: string) => {
  avatarFailed.value = new Set([...avatarFailed.value, key]);
};

const avatarOf = (comment: Comment) => comment.userPic || comment.avatar || '';
const likesOf = (comment: Comment) =>
  Number(comment.likeCount ?? comment.like?.count ?? 0) || 0;

/**
 * 时间显示。
 *
 * 上游给的是 `YYYY-MM-DD HH:mm:ss`；只显示到"月-日"，
 * 评论时间精确到秒没有意义，反而让列表更吵。
 */
const formatTime = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return text;
  const [, year, month, day] = match;
  const currentYear = String(new Date().getFullYear());
  return year === currentYear ? `${Number(month)}月${Number(day)}日` : `${year}年${Number(month)}月`;
};
</script>

<template>
  <Sheet
    :model-value="props.modelValue"
    :title="total ? `评论 ${total}` : '评论'"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <EmptyState v-if="!mixSongId" title="当前曲目暂不支持评论" />
    <EmptyState v-else-if="list.isLoading.value" tone="loading" title="正在加载评论" />
    <EmptyState
      v-else-if="list.error.value && !list.items.value.length"
      tone="error"
      title="评论加载失败"
      :description="list.error.value"
      action-label="重试"
      @action="list.reload()"
    />
    <EmptyState
      v-else-if="list.isEmpty.value"
      title="还没有评论"
      description="来做第一个评论的人吧"
    />

    <div v-else class="comment-list">
      <article v-for="comment in list.items.value" :key="String(comment.id)" class="comment">
        <div class="avatar">
          <img
            v-if="avatarOf(comment) && !avatarFailed.has(String(comment.id))"
            :src="avatarOf(comment)"
            alt=""
            loading="lazy"
            @error="onAvatarError(String(comment.id))"
          />
          <Icon v-else :icon="iconUser" width="18" height="18" />
        </div>

        <div class="body">
          <p class="meta">
            <span class="name ellipsis">{{ comment.userName || '匿名用户' }}</span>
            <!-- 类名不叫 .time：播放页的时间行也叫 .time，调试时选中会混淆 -->
            <span class="comment-time">{{ formatTime(comment.addTime || comment.time) }}</span>
          </p>
          <p class="content">{{ comment.content }}</p>
          <!-- 点赞数只作展示：内核没有点赞接口，不做可点的心形 -->
          <p v-if="likesOf(comment) > 0" class="likes">♡ {{ likesOf(comment) }}</p>
        </div>
      </article>

      <div :ref="list.sentinel" class="sentinel">
        <template v-if="list.isLoadingMore.value">正在加载更多…</template>
        <template v-else-if="list.error.value">
          <button type="button" class="retry" @click="list.retry()">加载失败，点击重试</button>
        </template>
        <template v-else-if="!list.hasMore.value">没有更多评论了</template>
      </div>
    </div>
  </Sheet>
</template>

<style scoped>
.comment-list {
  display: flex;
  flex-direction: column;
}

.comment {
  display: flex;
  gap: var(--sp-3);
  padding: var(--sp-3) 0;
}

.comment + .comment {
  border-top: 1px solid var(--divider);
}

.avatar {
  flex: 0 0 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  overflow: hidden;
  background: var(--fill-muted);
  color: var(--text-tertiary);
}

.avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}

.meta {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  margin: 0;
}

.name {
  flex: 1;
  min-width: 0;
  font-size: var(--font-sm);
  font-weight: var(--weight-medium);
  color: var(--text-secondary);
}

.comment-time {
  flex: 0 0 auto;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.content {
  margin: 0;
  font-size: var(--font-md);
  line-height: 1.55;
  color: var(--text-primary);
  word-break: break-word;
}

.likes {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.sentinel {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.retry {
  min-height: 36px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
  background: var(--accent-soft);
}
</style>
