<script setup lang="ts">
/**
 * 一起听（众乐房）。
 *
 * ## 一个页面两种视图
 *
 * `listenTogether` store 的 `joined` / `phase` 是**全局状态**（会话本身不属于某个路由），
 * 所以"房间列表"与"已进入的房间"放在同一个页面里按 `joined` 切换，
 * 而不是拆成两个路由 —— 否则用户在房间内按返回键会回到列表，
 * 但会话还在，界面与状态就对不上了。
 *
 * ## 房间里的播放由房主控制
 *
 * 非房主不能直接控制播放（内核用 `isOwner` 区分）：点歌走 `requestSong()`（请求播放），
 * 而不是本地 `playTrack` —— 后者只会让自己这边响，其他人听不到。
 * 这也是为什么这里不照搬播放页的传输行。
 *
 * ## 传输
 *
 * 上游这个功能是**心跳轮询**实现的（`heartbeatListenTogetherRoom` + setInterval），
 * 不依赖 WebSocket —— 所以 WebView 里直接可用，不需要原生补通道。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import Sheet from '@mobile/components/Sheet.vue';
import MediaCard from '@mobile/components/MediaCard.vue';
import { iconAdd, iconLock, iconRefresh, iconUser, iconWorld } from '@mobile/icons';
import { toListenTogetherAudioRefs } from '@/utils/listenTogether';
import type { ListenTogetherMusicProgressInfo } from '@/models/listenTogether';
import type { Song } from '@/models/song';
import { useListenTogetherStore } from '@/stores/listenTogether';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';

const router = useRouter();
const room = useListenTogetherStore();
const player = usePlayerStore();
const toast = useToastStore();

const previewOpen = ref(false);

/* ── 创建房间表单 ── */
const createOpen = ref(false);
const createName = ref('');
/** 1 = 公开，2 = 私密（内核 `ListenTogetherRoomPrivacy`） */
const createPrivacy = ref<1 | 2>(2);
/** 公开房间的代价：账号需具备公开创房权限，否则会被实名验证拦住 */
const createQueueCount = computed(() => (player.currentPlaylist ?? []).length);
const draft = ref('');
const busy = ref(false);

/* ── 列表 ── */
/** 返回是否成功：调用方（刷新）要据此决定要不要提示，失败时 load 内部已经 toast 过了 */
const load = async (reset = true): Promise<boolean> => {
  try {
    // roomType 只能是 0：上游已下线"自习室"，传其它值 store 会直接抛错
    await room.loadRooms({ reset, roomType: 0 });
    return true;
  } catch (error) {
    logger.warn('ListenTogether', 'Load rooms failed', error);
    toast.danger(error instanceof Error ? error.message : '房间列表加载失败');
    return false;
  }
};

/**
 * 手动刷新。
 *
 * 房间列表是有可能长期不变的一块内容（不像首页每次进来都重新拉），扫一眼发现没新房间
 * 时用户需要一个明确的“再拉一次”入口。成功后报一下数量：列表本身没变化时，
 * 光看界面分不出“刷新了但确实没有”和“压根没点上”。
 */
const refresh = async () => {
  if (room.loadingRooms) return;
  if (!(await load(true))) return;
  const count = room.rooms.length;
  toast.info(count ? `已刷新，共 ${count} 个房间` : '已刷新，暂时没有开放的房间');
};

const loadMore = () => {
  if (room.roomsEnded || room.loadingRooms) return;
  void load(false);
};

const openPreview = async (target: { id: string; roomType: number }) => {
  previewOpen.value = true;
  try {
    await room.inspectRoom(target as never);
  } catch (error) {
    logger.warn('ListenTogether', 'Inspect room failed', error);
    toast.danger(error instanceof Error ? error.message : '房间信息加载失败');
  }
};

const closePreview = () => {
  previewOpen.value = false;
  room.closePreview();
};

/* ── 进入 / 退出 ── */
const join = async () => {
  const target = room.previewRoom;
  if (!target || busy.value) return;
  busy.value = true;
  try {
    await room.joinRoom(target);
    closePreview();
    toast.success('已进入房间');
  } catch (error) {
    logger.warn('ListenTogether', 'Join room failed', error);
    toast.danger(error instanceof Error ? error.message : '加入房间失败');
  } finally {
    busy.value = false;
  }
};

const leave = async () => {
  if (busy.value) return;
  busy.value = true;
  try {
    await room.leaveRoom();
    toast.info('已退出房间');
  } catch (error) {
    logger.warn('ListenTogether', 'Leave room failed', error);
    toast.danger(error instanceof Error ? error.message : '退出房间失败');
  } finally {
    busy.value = false;
  }
};

/**
 * 房主当前播放位置。
 *
 * ⚠️ **服务端必需且不能为空** —— 缺了直接报 `params.progress_info is empty`（实测）。
 *
 * 不能只认 `currentTrackSnapshot`：冷启动时队列已经恢复了 30 首，但"当前曲目"
 * 要等用户真的点播才有。之前那样写会返回 undefined，于是**看上去是"私密房间建不了"**，
 * 实际跟房间权限毫无关系。所以当前曲目缺 hash / albumAudioId 时退回**队列第一首**
 * （正是房间将要同步播放的那首），进度记 0。
 *
 * 字段名与取值照搬参考产品的 `musicRoomProgressInfo`：
 * `pause` 用 1/2 而不是布尔，`play_mode` 是字符串 `'1'|'2'|'3'`（列表/单曲/随机）。
 */
const currentProgressInfo = (): ListenTogetherMusicProgressInfo | undefined => {
  /** 只有 hash 与 albumAudioId 都齐才能用：服务端两个都要 */
  const usable = (song: Song | null | undefined) => {
    const hash = String(song?.hash ?? '').trim();
    const albumAudioId = String(song?.mixSongId ?? song?.albumAudioId ?? '').trim();
    return hash && albumAudioId ? { hash, albumAudioId } : null;
  };

  const fromTrack = usable(player.currentTrackSnapshot as Song | null);
  const source = fromTrack ?? usable((player.currentPlaylist ?? [])[0]);
  if (!source) return undefined;

  const playing = Boolean(fromTrack) && player.isPlaying;
  return {
    hash: source.hash,
    album_audio_id: source.albumAudioId,
    progress: playing ? Math.max(0, Math.floor(player.currentTime || 0)) : 0,
    pause: playing ? 1 : 2,
    play_mode: player.playMode === 'single' ? '2' : player.playMode === 'random' ? '3' : '1',
  };
};

/**
 * 用当前播放队列开一间房。
 *
 * ## 房间权限必须让用户选，而且默认「私密」
 *
 * 上游对**公开房间**有单独的权限要求（参考产品的表单里就写着「可在广场发现；
 * 账号需具备公开创房权限」）。实测（同一账号、同一台机器）：
 *
 * · `privacy: 1`（公开） → 服务端返回验证类型 34（实名认证），建不了
 * · 私密房间          → **一次成功**，没有任何验证
 *
 * 之前这里把 `privacy` 硬编码成 1（照搬上游的默认值）且没有选的入口，
 * 于是必然撞上实名要求。所以：默认改成**私密**（能直接用），公开作为可选项
 * 并在选中时把代价说清楚 —— 这是有意识与上游不一致的地方。
 *
 * ## 为什么现在改成弹表单
 *
 * 原来是一键创建（自动命名、沿用当前队列），理由是手机上少一层交互。
 * 但权限既然必须选，就绕不开一个表单；那就顺手把房间名也放进去（预填好），
 * 用户直接按「创建」即可，不会比以前多几步。
 */
const openCreate = () => {
  const queue = player.currentPlaylist ?? [];
  if (!queue.length) {
    toast.warning('先在首页放首歌，再用当前队列开房间');
    return;
  }
  // 房间名同样不能只认当前曲目：未点播时用队列第一首的名字（实测冷启动会拿到 undefined）
  const seed = (player.currentTrackSnapshot as Song | null) ?? (player.currentPlaylist ?? [])[0];
  createName.value = `${seed?.title || seed?.name || '一起听'} 的房间`;
  // 默认私密 —— 公开需要账号具备公开创房权限，选了可能直接被验证拦住
  createPrivacy.value = 2;
  createOpen.value = true;
};

const submitCreate = async () => {
  const queue = player.currentPlaylist ?? [];
  if (!queue.length) {
    toast.warning('先在首页放首歌，再用当前队列开房间');
    return;
  }
  const name = createName.value.trim() || '一起听 的房间';
  if (busy.value) return;
  busy.value = true;
  try {
    /**
     * `audios` 走内核的 `toListenTogetherAudioRefs`，不自己 map：
     * 它会**先滤掉没有 hash 的歌**、并把 `mixSongId` 回落到 `albumAudioId`。
     * 自己写 `queue.map(song => ({ hash, mixSongId }))` 会把 hash 为空的歌
     * 也发上去，服务端同样报 20003（踩过）。
     */
    await room.createRoom(
      {
        name,
        notice: '',
        roomType: 0,
        privacy: createPrivacy.value,
        capacity: 5,
        progressInfo: currentProgressInfo(),
        audios: toListenTogetherAudioRefs(queue as Song[], 50),
      },
      queue,
    );
    createOpen.value = false;
    toast.success('房间已创建');
  } catch (error) {
    logger.warn('ListenTogether', 'Create room failed', error);
    toast.danger(error instanceof Error ? error.message : '创建房间失败');
  } finally {
    busy.value = false;
  }
};

/* ── 房间内 ── */
const messageList = computed(() => room.messages ?? []);
const memberList = computed(() => room.members ?? []);
const songList = computed(() => room.roomSongs ?? []);

const sendMessage = async () => {
  const text = draft.value.trim();
  if (!text || room.sendingMessage) return;
  try {
    await room.sendMessage(text);
    draft.value = '';
  } catch (error) {
    toast.danger(error instanceof Error ? error.message : '发送失败');
  }
};

const requestSong = async (song: { hash: string }) => {
  try {
    await room.requestSong(song as never);
    toast.success('已请求播放');
  } catch (error) {
    toast.danger(error instanceof Error ? error.message : '点歌失败');
  }
};

const roomTitle = computed(() => room.activeRoom?.name || '一起听');
const ownerName = computed(() => room.activeRoom?.ownerName || '');
const memberCount = computed(() => room.activeRoom?.memberCount ?? memberList.value.length);
/** 房间内的当前曲目：内核会把它同步给所有人 */
const nowPlaying = computed(() => room.currentRoomSong ?? null);

onMounted(() => {
  // 已经在房间里（比如切走又切回来）就直接恢复会话，不重新拉列表
  if (room.joined) {
    void room.recoverCurrentMusicRoomSession?.().catch(() => undefined);
    return;
  }
  void load(true);
});

onBeforeUnmount(() => {
  // 列表页的预览要收掉；**房间会话不自动退出** ——
  // 用户切到别的页签还要继续一起听（音频是后台播的）
  room.closePreview();
});

const goBackToList = () => {
  if (window.history.length > 1) router.back();
  else void router.replace({ name: 'home' });
};
</script>

<template>
  <div class="lt-page">
    <!--
      不放 PageHeader：页面在「主页」分区下，顶部子页签栏已表明位置。
      功能性按钮改成了不占布局高度的形式：列表页用右下角悬浮钮（FAB），
      房间内把「退出房间」放到房间信息行右侧。
    -->

    <!-- ── 房间内 ── -->
    <template v-if="room.joined">
      <div class="room-head">
        <div class="room-head-top">
          <p class="room-name ellipsis">{{ roomTitle }}</p>
          <button
            type="button"
            class="leave-button"
            :disabled="busy"
            @click="leave"
          >
            退出房间
          </button>
        </div>
        <div class="members">
          <template v-for="member in memberList" :key="member.userId">
            <div class="member" :class="{ 'is-owner': String(member.userId) === String(room.activeRoom?.ownerId) }">
              <img v-if="member.avatarUrl" class="member-avatar" :src="member.avatarUrl" alt="" />
              <span v-else class="member-avatar"><Icon :icon="iconUser" width="16" height="16" /></span>
              <span class="member-name ellipsis">{{ member.nickname }}</span>
            </div>
          </template>
        </div>
        <p class="room-meta">
          房主 {{ ownerName || '—' }} · {{ memberCount }} 人在听
          <span v-if="room.isOwner" class="owner-badge">你是房主</span>
        </p>
      </div>

      <!-- 当前播放：非房主不能直接控制播放 -->
      <section class="now">
        <p class="now-label">当前播放</p>
        <p class="now-title ellipsis">{{ nowPlaying?.title || '暂无' }}</p>
        <p class="now-artist ellipsis">{{ nowPlaying?.artist || '' }}</p>
      </section>

      <!-- 房间队列 -->
      <section class="block">
        <header class="block-head">
          <h2 class="block-title">房间队列（{{ songList.length }}）</h2>
          <button type="button" class="block-action" @click="room.refreshRoomSongs?.()">
            <Icon :icon="iconRefresh" width="15" height="15" />
          </button>
        </header>
        <EmptyState v-if="!songList.length" title="房间里还没有歌" description="去别处点歌，从这里请求播放" />
        <button
          v-for="song in songList.slice(0, 50)"
          :key="song.id"
          type="button"
          class="song-item"
          @click="requestSong(song)"
        >
          <span class="song-title ellipsis">{{ song.title }}</span>
          <span class="song-artist ellipsis">{{ song.artist }}</span>
        </button>
      </section>

      <!-- 聊天 -->
      <section class="block">
        <header class="block-head">
          <h2 class="block-title">聊天</h2>
        </header>
        <EmptyState v-if="!messageList.length" title="还没有人发言" />
        <div v-else class="messages">
          <p v-for="message in messageList.slice(-40)" :key="message.id" class="message">
            <span class="message-name">{{ message.nickname }}</span>
            <span class="message-text">{{ message.text }}</span>
          </p>
        </div>
      </section>

      <div class="composer">
        <input
          v-model="draft"
          class="composer-input"
          type="text"
          placeholder="说点什么…"
          @keyup.enter="sendMessage"
        />
        <button type="button" class="composer-submit" :disabled="!draft.trim()" @click="sendMessage">
          发送
        </button>
      </div>
    </template>

    <!-- ── 房间列表 ── -->
    <div v-else class="page-body">
      <!-- 悬浮创建钮：不占布局高度，也不会像顶部子页签栏那样挤在一起 -->
      <button
        type="button"
        class="fab"
        :disabled="busy"
        aria-label="用当前队列开房间"
        @click="openCreate"
      >
        <Icon :icon="iconAdd" width="24" height="24" />
      </button>

      <!-- 刷新：列表可能长期不变，给一个明确的手动拉取入口 -->
      <div class="list-toolbar">
        <button
          type="button"
          class="refresh-button"
          :disabled="room.loadingRooms"
          aria-label="刷新房间列表"
          @click="refresh"
        >
          <Icon
            :icon="iconRefresh"
            width="16"
            height="16"
            :class="{ 'is-spinning': room.loadingRooms }"
          />
          刷新
        </button>
      </div>

      <div class="page-body-scroll scroll-y">
        <EmptyState v-if="room.loadingRooms && !room.rooms.length" tone="loading" title="正在加载房间" />
        <EmptyState
          v-else-if="!room.rooms.length"
          title="暂时没有开放的房间"
          description="点右下角＋，用你正在听的队列开一间"
        />

        <template v-else>
          <div class="grid">
            <MediaCard
              v-for="item in room.rooms"
              :key="item.id"
              :cover="item.ownerAvatarUrl"
              :title="item.name"
              :subtitle="`${item.ownerName} · ${item.memberCount} 人`"
              @select="openPreview(item)"
            />
          </div>
          <button
            v-if="!room.roomsEnded"
            type="button"
            class="load-more"
            :disabled="room.loadingRooms"
            @click="loadMore"
          >
            {{ room.loadingRooms ? '加载中…' : '加载更多' }}
          </button>
          <p v-else class="list-end">没有更多房间了</p>
        </template>
      </div>
    </div>
  </div>

  <!-- 房间预览 + 加入 -->
  <Sheet v-model="previewOpen" :title="room.previewRoom?.name || '房间'" @update:model-value="closePreview">
    <EmptyState v-if="room.loadingPreview" tone="loading" title="正在加载房间信息" />
    <template v-else-if="room.previewRoom">
      <p class="preview-meta">
        房主 {{ room.previewRoom.ownerName }} · {{ room.previewRoom.memberCount }} 人在听
      </p>
      <p v-if="room.previewMembers.length" class="preview-label">房间成员</p>
      <div class="members">
        <div v-for="member in room.previewMembers" :key="member.userId" class="member">
          <img v-if="member.avatarUrl" class="member-avatar" :src="member.avatarUrl" alt="" />
          <span v-else class="member-avatar"><Icon :icon="iconUser" width="16" height="16" /></span>
          <span class="member-name ellipsis">{{ member.nickname }}</span>
        </div>
      </div>
      <p class="preview-note">
        进入后会同步房主的播放；点歌需要房主同意后才会播放。
      </p>
    </template>
    <template #footer>
      <button type="button" class="join-button" :disabled="busy || !room.previewRoom" @click="join">
        {{ busy ? '进入中…' : '进入房间' }}
      </button>
    </template>
  </Sheet>

  <!-- 创建众乐房：房间权限必须选，默认私密（公开需要账号具备公开创房权限） -->
  <Sheet v-model="createOpen" title="创建众乐房">
    <p class="create-hint">创建时会沿用当前播放队列（{{ createQueueCount }} 首）。</p>

    <p class="preview-label">房间名称</p>
    <input v-model="createName" class="create-input" type="text" placeholder="房间名称" />

    <p class="preview-label">房间权限</p>
    <div class="privacy-options">
      <button
        type="button"
        class="privacy-option"
        :class="{ 'is-selected': createPrivacy === 2 }"
        @click="createPrivacy = 2"
      >
        <Icon :icon="iconLock" width="18" height="18" />
        <strong>私密房间</strong>
        <small>仅限受邀成员，最多 5 人</small>
      </button>
      <button
        type="button"
        class="privacy-option"
        :class="{ 'is-selected': createPrivacy === 1 }"
        @click="createPrivacy = 1"
      >
        <Icon :icon="iconWorld" width="18" height="18" />
        <strong>公开房间</strong>
        <small>可在广场发现</small>
      </button>
    </div>
    <p v-if="createPrivacy === 1" class="create-warning">
      公开房间需要账号具备公开创房权限。实测这个权限不足时，服务端会要求实名认证 ——
      若被拦住，改用「私密房间」即可直接创建。
    </p>

    <template #footer>
      <button type="button" class="join-button" :disabled="busy" @click="submitCreate">
        {{ busy ? '创建中…' : '创建众乐房并进入' }}
      </button>
    </template>
  </Sheet>
</template>

<style scoped>
.lt-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.header-action {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 34px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--accent);
  background: var(--accent-soft);
}

.page-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 列表工具栏：只放刷新，固定在滚动区之外（列表滚动时它不跟着跑） */
.list-toolbar {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
  padding: 0 var(--sp-4) var(--sp-1);
}

.refresh-button {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

.refresh-button:active:not(:disabled) {
  background: var(--fill-muted);
  color: var(--text-primary);
}

.refresh-button:disabled {
  opacity: 0.6;
}

/* 加载中让图标转起来：否则点了之后没有任何反馈 */
.refresh-button .is-spinning {
  animation: refresh-spin 900ms linear infinite;
}

@keyframes refresh-spin {
  to {
    transform: rotate(360deg);
  }
}

.page-body-scroll {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-10);
}

/* 悬浮创建钮 */
.fab {
  position: absolute;
  right: var(--sp-4);
  /* 停在底部栏上方（内容区已被外壳扣掉底部高度，这里再留一点） */
  bottom: var(--sp-4);
  z-index: var(--z-sticky);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  color: var(--accent-on);
  background: var(--accent);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.fab:active:not(:disabled) {
  transform: scale(0.94);
}

/* ── 创建房间表单 ── */
.create-hint {
  margin: 0 0 var(--sp-4);
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.create-input {
  width: 100%;
  min-height: 44px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--divider-strong);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  font-size: var(--font-md);
  color: var(--text-primary);
}

.create-input::placeholder {
  color: var(--text-tertiary);
}

.privacy-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}

.privacy-option {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: var(--sp-3);
  border: 1px solid var(--divider-strong);
  border-radius: var(--radius-md);
  text-align: left;
  color: var(--text-secondary);
}

.privacy-option.is-selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.privacy-option strong {
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.privacy-option.is-selected strong {
  color: var(--accent);
}

.privacy-option small {
  font-size: var(--font-xs);
  line-height: var(--leading-tight);
  color: var(--text-tertiary);
}

.create-warning {
  margin: var(--sp-3) 0 0;
  font-size: var(--font-xs);
  line-height: var(--leading-normal);
  color: var(--warning);
}

.fab:disabled {
  opacity: 0.6;
}

/* 房间内顶部：房名 + 退出，同一行不额外占高度 */
.room-head-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-bottom: var(--sp-3);
}

.room-name {
  margin: 0;
  font-size: var(--font-xl);
  font-weight: var(--weight-bold);
}

.leave-button {
  flex: 0 0 auto;
  min-height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--danger);
  background: rgba(244, 69, 61, 0.14);
}

.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--sp-4) var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
}

.load-more {
  display: block;
  width: calc(100% - 32px);
  margin: var(--sp-4) auto 0;
  min-height: 46px;
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

.list-end {
  margin: var(--sp-4) 0 0;
  text-align: center;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

/* ── 房间内 ── */
.room-head {
  padding: var(--sp-2) var(--sp-4) var(--sp-3);
}

.members {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
}

.member {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  width: 56px;
}

.member-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  overflow: hidden;
  object-fit: cover;
  background: var(--fill-muted);
  color: var(--text-tertiary);
}

.member.is-owner .member-avatar {
  box-shadow: 0 0 0 2px var(--accent);
}

.member-name {
  max-width: 100%;
  font-size: 10px;
  color: var(--text-secondary);
}

.room-meta {
  margin: var(--sp-3) 0 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.owner-badge {
  margin-left: var(--sp-2);
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  color: var(--accent);
  background: var(--accent-soft);
}

.now {
  margin: 0 var(--sp-4) var(--sp-3);
  padding: var(--sp-3);
  border-radius: var(--radius-md);
  background: var(--bg-raised);
  border: 1px solid var(--divider);
}

.now-label {
  margin: 0 0 4px;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.now-title {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
}

.now-artist {
  margin: 2px 0 0;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.block {
  padding: 0 var(--sp-4) var(--sp-4);
}

.block-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-2);
}

.block-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
}

.block-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  color: var(--text-secondary);
}

.song-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 100%;
  min-height: 48px;
  padding: var(--sp-2) var(--sp-1);
  text-align: left;
  border-radius: var(--radius-sm);
}

.song-item:active {
  background: var(--fill-subtle);
}

.song-title {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.song-artist {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.messages {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  max-height: 240px;
  overflow-y: auto;
}

.message {
  margin: 0;
  font-size: var(--font-sm);
  line-height: 1.5;
}

.message-name {
  margin-right: var(--sp-2);
  color: var(--accent);
}

.message-text {
  color: var(--text-primary);
}

.composer {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4) calc(var(--safe-bottom) + var(--sp-3));
  background: var(--bg-base);
  border-top: 1px solid var(--divider);
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

/* ── 预览 ── */
.preview-meta {
  margin: 0 0 var(--sp-3);
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.preview-label {
  margin: 0 0 var(--sp-2);
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.preview-note {
  margin: var(--sp-4) 0 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.join-button {
  width: 100%;
  min-height: 48px;
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.join-button:disabled {
  opacity: 0.45;
}
</style>
