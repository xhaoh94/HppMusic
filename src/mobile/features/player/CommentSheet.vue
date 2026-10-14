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
import ActionSheet from '@mobile/components/ActionSheet.vue';
import { useInfiniteList } from '@mobile/composables/useInfiniteList';
import { useNowPlaying } from '@mobile/adapters/player';
import { deleteComment, replyComment, sendMusicComment } from '@mobile/adapters/comment';
import { getMusicComments } from '@/api/comment';
import { mapCommentItem } from '@/utils/mappers';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';
import { iconUser } from '@mobile/icons';
import type { Comment } from '@/models/comment';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const { track } = useNowPlaying();
const user = useUserStore();
const toast = useToastStore();

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

/* ────────────────────────────────────────────────────────
   发表 / 回复 / 删除
   ──────────────────────────────────────────────────────── */

const draft = ref('');
/** 正在回复的目标；为空表示发顶层评论 */
const replyTo = ref<Comment | null>(null);
const submitting = ref(false);

const sheetOpen = ref(false);
const selectedComment = ref<Comment | null>(null);

const currentUserId = computed(() => String(user.info?.userid ?? ''));
/** 只能删自己的评论（服务端也会拦，但先在界面上不给自己添堵） */
const isOwnComment = (comment: Comment) =>
  Boolean(currentUserId.value) && String(comment.userId ?? '') === currentUserId.value;

const sheetItems = computed(() => {
  const comment = selectedComment.value;
  if (!comment) return [];
  const items = [
    { key: 'reply', label: '回复', description: `回复 ${comment.userName || '这条评论'}` },
  ];
  if (isOwnComment(comment)) {
    items.push({
      key: 'delete',
      label: '删除',
      description: '删除后不可恢复',
      danger: true,
    } as never);
  }
  return items;
});

const onLongPress = (comment: Comment) => {
  selectedComment.value = comment;
  sheetOpen.value = true;
};

const onSheetSelect = async (key: string) => {
  const comment = selectedComment.value;
  selectedComment.value = null;
  if (!comment) return;

  if (key === 'reply') {
    replyTo.value = comment;
    return;
  }
  if (key === 'delete') {
    try {
      await deleteComment(String(comment.id));
      toast.success('已删除');
      void list.reload();
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : '删除失败');
    }
  }
};

const cancelReply = () => {
  replyTo.value = null;
};

const submitDraft = async () => {
  const text = draft.value.trim();
  if (!text || submitting.value) return;
  submitting.value = true;
  try {
    if (replyTo.value) {
      await replyComment(replyTo.value, text);
      toast.success('已回复');
    } else {
      if (!mixSongId.value) throw new Error('当前曲目不支持评论');
      await sendMusicComment(mixSongId.value, text);
      toast.success('已发表');
    }
    draft.value = '';
    replyTo.value = null;
    // 重新拉第一页：新评论在最前面
    void list.reload();
  } catch (error) {
    logger.warn('Comment', 'Submit failed', error);
    toast.danger(error instanceof Error ? error.message : '发表失败，请稍后重试');
  } finally {
    submitting.value = false;
  }
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
      <article
        v-for="comment in list.items.value"
        :key="String(comment.id)"
        class="comment"
        @pointerdown.passive="() => undefined"
        @contextmenu.prevent
        @click="onLongPress(comment)"
      >
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

    <!-- 发表／回复：固定在底部（键盘弹出时会跟着上移，因为它是 Sheet 内的固定区） -->
    <template #footer>
      <div class="composer">
        <p v-if="replyTo" class="reply-hint">
          回复 {{ replyTo.userName || '这条评论' }}
          <button type="button" class="reply-cancel" @click="cancelReply">取消</button>
        </p>
        <div class="composer-row">
          <input
            v-model="draft"
            class="composer-input"
            type="text"
            :placeholder="replyTo ? '写下回复…' : '说点什么…'"
            :disabled="submitting"
            @keyup.enter="submitDraft"
          />
          <button
            type="button"
            class="composer-submit"
            :disabled="submitting || !draft.trim()"
            @click="submitDraft"
          >
            {{ submitting ? '发送中' : '发送' }}
          </button>
        </div>
      </div>
    </template>
  </Sheet>

  <ActionSheet
    v-model="sheetOpen"
    :subject="selectedComment?.content"
    :items="sheetItems"
    @select="onSheetSelect"
  />
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
  /* 长按选中文字会和长按菜单冲突，禁掉选择 */
  user-select: none;
  -webkit-user-select: none;
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

/* ── 发表／回复 ── */
.composer {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.reply-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-secondary);
}

.reply-cancel {
  color: var(--accent);
  font-size: var(--font-xs);
}

.composer-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.composer-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  border: 1px solid var(--divider);
  background: var(--bg-input);
  font-size: var(--font-sm);
  outline: none;
}

.composer-input:focus {
  border-color: var(--accent);
}

.composer-submit {
  flex: 0 0 auto;
  min-height: 36px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.composer-submit:disabled {
  opacity: 0.45;
}
</style>
