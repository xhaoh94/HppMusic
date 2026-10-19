<script setup lang="ts">
/**
 * 随便听（原「免费听」）。
 *
 * ## 为什么改名
 *
 * 「免费听」这个名字是**误读**的。查证结果：
 * · 接口的真实上游是 `/concepts/v1/ai/recommend_song` —— 是**酷狗概念版**的 AI 推荐
 *   （路由 `/ai/recommend/song` 只是 KuGouMusicApi 的包装名）
 * · 概念版是酷狗的"免费听歌产品"，它的免费能力来自**畅听VIP**（账号里 `busi_vip`
 *   的 `tvip`），靠签到/活动赠送、当天签当天有效
 * · 所以"能不能免费听"取决于**账号特权**，跟歌是从哪个接口来的无关。
 *   实测：每日推荐里标着 `pay_type=3` 的付费歌，在同一账号下同样能拿到音源并播放
 *
 * 频道实际提供的体验是"一次给一批、不满意换一批、不用自己挑"，所以叫「随便听」。
 *
 * ⚠️ 路由 path、`name`、目录名与 `queueId` 仍保留 `free-listen`：改 path 会破坏
 * 深链接，改 queueId 会让已持久化的播放队列快照对不上（那是写进 storage 的）。
 *
 * ## 三个从上游继承下来的处理（都不是可有可无的）
 *
 * 1. **去重**：这个接口会返回重复歌曲（同一首多次出现）。上游用
 *    `mixSongId || hash || id` 做 key 过滤，照搬 —— 不去重时列表里会看到
 *    连着好几首一模一样的歌。
 * 2. **刷新时清空搜索词**：用户点了"换一批"却发现列表没变（因为搜索词还在过滤），
 *    这是很常见的误解来源。
 * 3. **代次 + 会话检查**：请求是异步的，期间用户可能换账号或连点刷新；
 *    不检查的话旧账号的数据会写回当前列表。
 *
 * ## 页面内搜索
 *
 * 这个频道一次给几十首，滑动找歌很低效，所以页内放一个过滤框
 * （只是**本地过滤**，不触发搜索接口 —— 它是"在结果里找"，不是"搜全网"）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import SongRow from '@mobile/components/SongRow.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import { Icon } from '@iconify/vue';
import { iconClose, iconRefresh, iconSearch } from '@mobile/icons';
import { useNowPlaying, usePlaybackActions } from '@mobile/adapters/player';
import { FREE_LISTEN_QUEUE, fetchFreeListenSongs } from '@mobile/adapters/freeListen';
import { useCurrentSongKey, useLocatePlayingSong } from '@mobile/composables/useCurrentSong';
import { songKeyOf } from '@mobile/utils/songKey';
import { filterSongsByQuery } from '@/utils/songList';
import { captureUserSession } from '@/utils/userSession';
import { useUserStore } from '@/stores/user';
import logger from '@/utils/logger';
import type { Song } from '@/models/song';
import LocateCurrentButton from '@mobile/components/LocateCurrentButton.vue';

/** 组件名：App.vue 的 KeepAlive `:include` 按这个名字匹配（对不上是静默失效，不会报错） */
defineOptions({ name: 'FreeListenPage' });

const user = useUserStore();
const router = useRouter();
const { isPlaying } = useNowPlaying();
const { playSong, playList, activeQueue, remainingInQueue, appendToActiveQueue } =
  usePlaybackActions();

const QUEUE_META = FREE_LISTEN_QUEUE;

const songs = ref<Song[]>([]);
const loading = ref(true);
const loadError = ref('');
const searchQuery = ref('');

/** 已收录的歌曲 key，用于跨批次去重 */
const seenKeys = new Set<string>();
let loadGeneration = 0;

const songKey = (song: Song) => String(song.mixSongId || song.hash || song.id || '');

const displayedSongs = computed(() => filterSongsByQuery(songs.value, searchQuery.value));

// 当前播放标记 + 首次打开列表自动定位到正在播的那首
const { currentSongKey } = useCurrentSongKey();
useLocatePlayingSong(displayedSongs, currentSongKey);

const collectSongs = (list: Song[]): Song[] => {
  const batch: Song[] = [];
  for (const song of list) {
    const key = songKey(song);
    if (!key || !song.id || seenKeys.has(key)) continue;
    seenKeys.add(key);
    batch.push(song);
  }
  return batch;
};

/**
 * 拉列表。默认会先尝试**从活动队列还原**，只有确认没得还原才真的去拉。
 *
 * 为什么：`songs` 是页面本地状态，重启 App 再进随便听就会重新拉一批 ——
 * 用户正在听的那首歌虽然在队列里（所以能接着播），列表却已经被换成新的一批，
 * 上下滑找不到刚才那首。队列本身是持久化的，直接用它还原即可。
 *
 * 会真的去拉的三种情况：
 * · 活动队列不是随便听的（或压根没有）—— 没得还原；
 * · 用户点「换一批」（force）；
 * · 列表听完了要续 —— 那是 appendMore 的追加，不走这里。
 */
const load = async (options?: { force?: boolean }) => {
  if (!options?.force && ownsActiveQueue.value) {
    const queued = activeQueue.value?.songs ?? [];
    if (queued.length > 0) {
      // seenKeys 必须一起重建：否则 appendMore 的去重会把这些歌当成"没见过"
      seenKeys.clear();
      songs.value = collectSongs(queued);
      loading.value = false;
      loadError.value = '';
      logger.info('FreeListen', 'Restored list from active queue:', songs.value.length);
      return;
    }
  }
  const generation = ++loadGeneration;
  const isSessionCurrent = captureUserSession(user);
  loading.value = true;
  loadError.value = '';
  seenKeys.clear();
  try {
    const batch = await fetchFreeListenSongs();
    if (generation !== loadGeneration || !isSessionCurrent()) return;
    songs.value = collectSongs(batch);
  } catch (error) {
    if (generation !== loadGeneration || !isSessionCurrent()) return;
    logger.warn('FreeListen', 'Load failed', error);
    songs.value = [];
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === loadGeneration) loading.value = false;
  }
};

/** 换一批：连搜索词一起清掉，否则列表看起来"没变化"；force 绕过队列还原 */
const refresh = async () => {
  searchQuery.value = '';
  await load({ force: true });
};

const clearSearch = () => {
  searchQuery.value = '';
};

/**
 * 点击列表里的某一首。
 *
 * 是否跳播放页由设置里的「点歌后进入播放页」决定（默认关）。两种都合理：
 * 关着方便连着试听几首；开着则是"挑了就走"，不用再多点一次。
 *
 * ⚠️ **先跳页、再起播**（不 await 起播链路）。`playSong` 内部要等一次"拉播放地址"的
 * 网络往返，慢的时候几百毫秒起步，等它回来再 `router.push` 就是用户感觉到的
 * "点了没反应"。
 *
 * 为什么先跳也不会闪上一首：队列是**同步**设好的 —— 内核 `replaceQueueAndPlay` 里
 * `setPlaybackQueueWithOptions` 在 `playTrack` 的 await **之前**执行，
 * 所以播放页一进去就读到正确的曲目；只有播放地址与真正出声会晚一点，
 * 那时播放页自己显示加载态，比"点下去没动静"可解释得多。
 */
const onSelect = (song: Song) => {
  const context = displayedSongs.value;
  // 点歌直接进播放页（原「点歌后进播放页」设置已去掉，这个行为固定下来）
  void router.push({ name: 'player' });
  void playSong(song, context, QUEUE_META).catch((error) => {
    // 原来这里是 await，reject 会变成未处理的 Promise rejection；显式接住，只记日志
    logger.warn('FreeListen', 'Play failed', error);
  });
};


/**
 * 当前活动队列是不是本页开的那个。
 *
 * 预取必须检查：用户可能从这里播着播着又去别的页开了一个队列，
 * 那时 `remainingInQueue` 反映的是**新队列**的剩余量，跟着它追加会把
 * 随便听的歌塞进别人的队列里。
 */
const ownsActiveQueue = computed(
  () => String(activeQueue.value?.id ?? '') === QUEUE_META.queueId,
);

/** 剩这么几首时就去拉下一批（不是 0：等播完再拉会静音一下） */
const PREFETCH_AT = 3;
/** 预取中：防止同一批被拉两次 */
let prefetching = false;

/**
 * 再拉一批**追加**在后面（增量）。
 *
 * 与 `refresh`（换一批）的区别：那个是**替换**整个列表，这个只追加。
 *
 * 两处都要动，少一个都不行：
 * · 页面列表 —— 用户看到的变多；
 * · 播放队列 —— 只改列表的话队列还是 30 首，**播完照样会停**。
 *   `appendToActiveQueue` 走内核的 `appendToPlaybackQueue`，它自己去重。
 *
 * 去重靠 `collectSongs`（内部查 `seenKeys`），与首批同一套。
 */
const appendMore = async () => {
  if (prefetching || loading.value) return;
  prefetching = true;
  const isSessionCurrent = captureUserSession(user);
  try {
    const batch = await fetchFreeListenSongs();
    if (!isSessionCurrent()) return;
    const fresh = collectSongs(batch);
    if (!fresh.length) return;
    songs.value = [...songs.value, ...fresh];
    appendToActiveQueue(fresh);
    logger.info('FreeListen', 'Prefetched more:', fresh.length);
  } catch (error) {
    // 静默失败：这是后台预取，不该弹提示打断听歌；下次切歌时还会再试
    logger.warn('FreeListen', 'Prefetch more failed', error);
  } finally {
    prefetching = false;
  }
};

watch(remainingInQueue, (left) => {
  if (!ownsActiveQueue.value) return;
  // left 为 0 表示已经是最后一首（或已播完），也拉一把兜底
  if (left <= PREFETCH_AT) void appendMore();
});

const playAll = async () => {
  const context = displayedSongs.value;
  if (!context.length) return;
  await playList(context, QUEUE_META);
};

/**
 * 切页签时「自动播 + 进播放页」已经上移到**路由守卫**里做了（见 router/index.ts）：
 * 在进入前改道，列表根本不会渲染，也就没有"先闪一下列表再跳"的延迟。
 *
 * 这里**不能再做一次** —— 从播放页返回时「没在播」同样成立（用户可能刚暂停），
 * 页面里再判一次就会把人又弹回去。
 */
onMounted(() => void load());
</script>

<template>
  <div class="free-page">
    <!-- 定位到正在播放：列表长时不用自己翻 -->
    <LocateCurrentButton :songs="displayedSongs" />
    <!--
      不放 PageHeader：页面已经在「主页」分区下，顶部子页签栏已经表明当前位置，
      再顶一行「‹ 随便听」是重复信息（用户直接反馈过）。
      原本在 PageHeader 里的「换一批」挪到搜索栏右侧，省下一整行高度。
    -->
    <div class="toolbar">
      <div class="search-bar">
        <Icon :icon="iconSearch" width="16" height="16" class="search-icon" />
        <input
          v-model="searchQuery"
          class="search-input"
          type="search"
          enterkeyhint="search"
          autocapitalize="off"
          autocomplete="off"
          placeholder="在本批推荐中查找"
          aria-label="在本批推荐中查找"
        />
        <button
          v-if="searchQuery"
          type="button"
          class="clear-button"
          aria-label="清空"
          @click="clearSearch"
        >
          <Icon :icon="iconClose" width="15" height="15" />
        </button>
      </div>

      <!-- 播放全部放在搜索框右侧（与「我喜欢」页签一致），换一批挪到列表头上 -->
      <button v-if="displayedSongs.length" type="button" class="play-all" @click="playAll">
        播放全部
      </button>
    </div>

    <div class="page-body scroll-y">
      <EmptyState v-if="loading && !songs.length" tone="loading" title="正在加载免费歌曲" />
      <EmptyState
        v-else-if="loadError"
        tone="error"
        title="加载失败"
        :description="loadError"
        action-label="重试"
        @action="load"
      />
      <EmptyState
        v-else-if="!songs.length"
        title="暂时没有免费歌曲"
        description="稍后再试，或者点列表上方换一批"
      />
      <EmptyState
        v-else-if="!displayedSongs.length"
        title="本批推荐里没有匹配的歌"
        description="换个关键词，或者清空搜索看看全部"
        action-label="清空搜索"
        @action="clearSearch"
      />

      <template v-else>
        <div class="list-head">
          <span class="list-count">{{ displayedSongs.length }} 首</span>
          <button
            type="button"
            class="refresh-button"
            :disabled="loading"
            aria-label="换一批"
            @click="refresh"
          >
            <Icon :icon="iconRefresh" width="18" height="18" :class="{ spin: loading }" />
          </button>
        </div>
        <SongRow
          v-for="(song, index) in displayedSongs"
          :key="`${song.id}-${index}`"
          :song="song"
          :active="songKeyOf(song) === currentSongKey"
          show-index
          :index="index"
          @select="onSelect"
        />
      </template>
    </div>
  </div>
</template>

<style scoped>
.free-page {
  /* 定位按钮的绝对定位参照 */
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.header-action:disabled {
  opacity: 0.5;
}

.header-action:active:not(:disabled) {
  background: var(--fill-muted);
}

/* 搜索栏 + 换一批：同一行 */
.toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-4) var(--sp-2);
}

.search-bar {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 40px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
}

.refresh-button {
  /* 挪到列表头里了，做成紧凑图标钮，不把那一行撑高 */
  flex: 0 0 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.refresh-button:disabled {
  opacity: 0.5;
}

.refresh-button:active:not(:disabled) {
  background: var(--fill-muted);
}

.search-icon {
  flex: 0 0 auto;
  color: var(--text-tertiary);
}

.search-input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: 0;
  background: none;
  outline: none;
  -webkit-appearance: none;
  appearance: none;
  font-size: var(--font-sm);
}

.search-input::-webkit-search-cancel-button {
  display: none;
}

.clear-button {
  flex: 0 0 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: var(--text-tertiary);
}

.page-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-4) var(--sp-2);
}

.list-count {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.play-all {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
