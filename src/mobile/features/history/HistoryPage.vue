<script setup lang="ts">
/**
 * 播放历史（本地）。
 *
 * 数据源是内核 `historyStore`，它从 `window.electron.storage` 读本地记录
 * （键 `echo.mobile.history`），**不需要登录** —— 这也是移动端唯一能离线看的列表。
 *
 * 切歌时内核的 player 会在真正的 play 事件里调 `recordPlay`，所以历史里出现的
 * 一定是真的播过的歌（而不是"点了但没播成"的）。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PageHeader from '@mobile/components/PageHeader.vue';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import ActionSheet from '@mobile/components/ActionSheet.vue';
import Sheet from '@mobile/components/Sheet.vue';
import { useHistoryStore } from '@/stores/historyStore';
import { usePlaybackActions } from '@mobile/adapters/player';
import { useToastStore } from '@/stores/toast';
import type { Song } from '@/models/song';

interface LocalHistoryEntry {
  song: Song;
  lastPlayedAt: number;
  playCount: number;
  historyKey: string;
}

const router = useRouter();
const history = useHistoryStore();
const toast = useToastStore();
const { playSong, manualQueueMeta } = usePlaybackActions();

interface HistoryRow {
  entry: LocalHistoryEntry;
  song: Song;
}

const rows = computed<HistoryRow[]>(() =>
  (history.entries as unknown as LocalHistoryEntry[]).map((entry) => ({
    entry,
    song: entry.song,
  })),
);

/** 播放上下文 = 整份历史，点一首能顺着往下听 */
const contextSongs = computed(() => rows.value.map((row) => row.song));

const sheetOpen = ref(false);
const clearOpen = ref(false);
const selected = ref<LocalHistoryEntry | null>(null);

const sheetItems = computed(() => {
  const entry = selected.value;
  if (!entry) return [];
  return [
    { key: 'remove', label: '从播放历史中移除', description: '只影响本机的历史记录', danger: true },
  ];
});

const onSelect = async (song: Song) => {
  await playSong(song, contextSongs.value, {
    ...manualQueueMeta,
    title: '播放历史',
  });
};

/**
 * 长按移除单条。
 *
 * 用 `historyKey` 而不是歌曲 id：同一首歌在不同时间播放会生成不同 key，
 * 而内核的去重是按歌曲身份做的，用 key 才能精确指向"这一条"。
 */
const onLongPress = (song: Song) => {
  const row = rows.value.find((item) => item.song === song);
  if (!row) return;
  selected.value = row.entry;
  sheetOpen.value = true;
};

const onSheetSelect = (key: string) => {
  const entry = selected.value;
  selected.value = null;
  if (key !== 'remove' || !entry) return;
  history.removeEntry(entry.historyKey);
  toast.success('已从播放历史中移除');
};

const doClear = () => {
  clearOpen.value = false;
  history.clear();
  toast.success('已清空播放历史');
};

/**
 * 播放次数与相对时间。
 *
 * 只显示"几天前/几小时前"这种粗粒度，不显示精确时间戳 —— 音乐历史里
 * 精确到秒没有意义，反而让列表变吵。
 */
const formatPlayedAt = (timestamp: number) => {
  const diff = Date.now() - Number(timestamp || 0);
  if (!Number.isFinite(diff) || diff < 0) return '';
  const minute = 60_000;
  if (diff < minute) return '刚刚';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))} 小时前`;
  if (diff < 30 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))} 天前`;
  const date = new Date(Number(timestamp));
  return `${date.getMonth() + 1}月${date.getDate()}日`;
};

onMounted(() => {
  void history.hydrate();
});
</script>

<template>
  <div class="history-page">
    <PageHeader title="播放历史">
      <template #actions>
        <button
          v-if="rows.length"
          type="button"
          class="header-action"
          @click="clearOpen = true"
        >
          清空
        </button>
      </template>
    </PageHeader>

    <div class="history-body scroll-y">
      <EmptyState
        v-if="!rows.length"
        title="还没有播放记录"
        description="播放过的歌会自动出现在这里，不需要登录"
        action-label="去首页听歌"
        @action="router.push({ name: 'home' })"
      />

      <div v-else class="history-list">
        <div v-for="row in rows" :key="row.entry.historyKey" class="history-row">
          <SongRow
            :song="row.song"
            @select="onSelect"
            @longpress="onLongPress"
          />
          <p class="history-meta">
            <span>{{ formatPlayedAt(row.entry.lastPlayedAt) }}</span>
            <span v-if="row.entry.playCount > 1"> · 播放 {{ row.entry.playCount }} 次</span>
          </p>
        </div>
        <p class="history-hint">长按任意一条可以移除</p>
      </div>
    </div>
  </div>

  <ActionSheet
    v-model="sheetOpen"
    :subject="selected?.song?.title"
    :items="sheetItems"
    @select="onSheetSelect"
  />

  <Sheet v-model="clearOpen" title="清空播放历史">
    <p class="confirm-text">将清空本机全部播放记录，且不可恢复。确定继续吗？</p>
    <template #footer>
      <div class="confirm-actions">
        <button type="button" class="ghost-button" @click="clearOpen = false">取消</button>
        <button type="button" class="danger-button" @click="doClear">清空</button>
      </div>
    </template>
  </Sheet>
</template>

<style scoped>
.history-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header-action {
  min-height: 36px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
}

.history-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.history-list {
  display: flex;
  flex-direction: column;
}

.history-row {
  display: flex;
  flex-direction: column;
}

/* 时间与次数压在歌曲行下方，比挤进行里更清爽（行内已有封面/标题/歌手/时长） */
.history-meta {
  margin: calc(var(--sp-1) * -1) var(--sp-4) var(--sp-2) 71px;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.history-hint {
  margin: var(--sp-4) 0 0;
  text-align: center;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.confirm-text {
  margin: 0;
  font-size: var(--font-md);
  color: var(--text-secondary);
}

.confirm-actions {
  display: flex;
  gap: var(--sp-3);
}

.ghost-button,
.danger-button {
  flex: 1;
  min-height: 48px;
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  font-weight: var(--weight-medium);
}

.ghost-button {
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

.danger-button {
  color: #fff;
  background: var(--danger);
}
</style>
