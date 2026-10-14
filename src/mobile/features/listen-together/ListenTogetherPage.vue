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
import PageHeader from '@mobile/components/PageHeader.vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import Sheet from '@mobile/components/Sheet.vue';
import MediaCard from '@mobile/components/MediaCard.vue';
import { iconAdd, iconRefresh, iconUser } from '@mobile/icons';
import { useListenTogetherStore } from '@/stores/listenTogether';
import { usePlayerStore } from '@/stores/player';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';

const router = useRouter();
const room = useListenTogetherStore();
const player = usePlayerStore();
const toast = useToastStore();

const previewOpen = ref(false);
const draft = ref('');
const busy = ref(false);

/* ── 列表 ── */
const load = async (reset = true) => {
  try {
    // roomType 只能是 0：上游已下线"自习室"，传其它值 store 会直接抛错
    await room.loadRooms({ reset, roomType: 0 });
  } catch (error) {
    logger.warn('ListenTogether', 'Load rooms failed', error);
    toast.danger(error instanceof Error ? error.message : '房间列表加载失败');
  }
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
 * 用当前播放队列开一间房。
 *
 * 单独做一个"填房间名 + 初始化歌曲"的表单在手机上是三层交互；
 * 而用户想开房的场景几乎都是"我正在听的这队歌，叫朋友一起听"，
 * 所以直接用当前队列，不需要他再挑一次歌。
 */
const createRoom = async () => {
  const queue = player.currentPlaylist ?? [];
  if (!queue.length) {
    toast.warning('先在首页放首歌，再用当前队列开房间');
    return;
  }
  if (busy.value) return;
  const name = `${player.currentTrackSnapshot?.title ?? '一起听'} 的房间`;
  busy.value = true;
  try {
    /**
     * 参数必须完整：`ListenTogetherCreateBase` 里 `notice` 与 `audios` 都是必需的，
     * 少了 `notice` 会在 store 内部 `input.notice.trim()` 直接抛
     * `Cannot read properties of undefined`（踩过）。
     * `audios` 的每一项要 `{ hash, mixSongId }`，不是 `{ hash, name }`。
     */
    await room.createRoom(
      {
        name,
        notice: '',
        roomType: 0,
        privacy: 1,
        audios: queue.map((song) => ({
          hash: String(song.hash ?? ''),
          mixSongId: String(song.mixSongId ?? ''),
        })),
      },
      queue,
    );
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
    <PageHeader :title="room.joined ? roomTitle : '一起听'">
      <template #actions>
        <button
          v-if="!room.joined"
          type="button"
          class="header-action"
          :disabled="busy"
          aria-label="用当前队列开房间"
          @click="createRoom"
        >
          <Icon :icon="iconAdd" width="18" height="18" />
        </button>
        <button
          v-else
          type="button"
          class="header-action is-danger"
          :disabled="busy"
          @click="leave"
        >
          退出房间
        </button>
      </template>
    </PageHeader>

    <!-- ── 房间内 ── -->
    <template v-if="room.joined">
      <div class="room-head">
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
    <div v-else class="page-body scroll-y">
      <EmptyState v-if="room.loadingRooms && !room.rooms.length" tone="loading" title="正在加载房间" />
      <EmptyState
        v-else-if="!room.rooms.length"
        title="暂时没有开放的房间"
        description="点右上角＋，用你正在听的队列开一间"
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

.header-action.is-danger {
  color: var(--danger);
  background: rgba(244, 69, 61, 0.14);
}

.page-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
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
