<script setup lang="ts">
/**
 * 我的。
 *
 * 只做真正能用的事：账号信息、三个真实的数据入口（收藏 / 历史 / 我的歌单）、
 * 设置、退出登录。不铺一排点了没反应的图标 —— 前身项目的「我的」页有 8 个入口，
 * 其中 5 个点进去是空白。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconAlbum, iconFavorite, iconHistory, iconSettings, iconUser } from '@mobile/icons';
import { useUserStore } from '@/stores/user';
import { usePlaylistStore } from '@/stores/playlist';
import { useHistoryStore } from '@/stores/historyStore';
import { useToastStore } from '@/stores/toast';
import Sheet from '@mobile/components/Sheet.vue';

const router = useRouter();
const user = useUserStore();
const playlist = usePlaylistStore();
const history = useHistoryStore();
const toast = useToastStore();

const confirmOpen = ref(false);

const nickname = computed(() => user.info?.nickname || user.info?.username || '未登录');
const avatar = computed(() => String(user.info?.pic || ''));
const userId = computed(() => String(user.info?.userid ?? ''));

/**
 * 入口右侧的计数。
 *
 * 只在**已经加载过**的时候显示数字：没加载过就显示 `—`，
 * 而不是显示 0 —— 0 会被理解成"确实没有收藏"，与"还没拉取"是两件事。
 */
const favoriteCount = computed(() =>
  playlist.favoritesLoaded ? String(playlist.favorites.length) : '',
);
const playlistCount = computed(() =>
  playlist.userPlaylists.length ? String(playlist.userPlaylists.length) : '',
);
const historyCount = computed(() =>
  history.hydrated ? String(history.entries.length) : '',
);

const entries = computed(() => [
  {
    key: 'favorites',
    title: '我的收藏',
    subtitle: '我喜欢',
    icon: iconFavorite,
    value: favoriteCount.value,
    to: { name: 'favorites' },
  },
  {
    key: 'playlists',
    title: '我的歌单',
    subtitle: '自建与收藏的歌单',
    icon: iconAlbum,
    value: playlistCount.value,
    to: { name: 'my-playlists' },
  },
  {
    key: 'history',
    title: '播放历史',
    subtitle: '本机记录，无需登录',
    icon: iconHistory,
    value: historyCount.value,
    to: { name: 'history' },
  },
  {
    key: 'settings',
    title: '设置',
    subtitle: '播放、音质、歌词与数据',
    icon: iconSettings,
    value: '',
    to: { name: 'settings' },
  },
]);

const open = (to: { name: string }) => void router.push(to);

const doLogout = () => {
  confirmOpen.value = false;
  user.logout();
  toast.info('已退出登录');
  void router.replace({ name: 'login' });
};
</script>

<template>
  <div class="profile-page scroll-y">
    <header class="account">
      <div class="avatar">
        <img v-if="avatar" :src="avatar" alt="" />
        <Icon v-else :icon="iconUser" width="26" height="26" />
      </div>
      <div class="account-text">
        <p class="account-name ellipsis">{{ nickname }}</p>
        <p v-if="userId" class="account-id">ID {{ userId }}</p>
      </div>
    </header>

    <nav class="entries">
      <button
        v-for="entry in entries"
        :key="entry.key"
        type="button"
        class="entry"
        @click="open(entry.to)"
      >
        <Icon :icon="entry.icon" width="20" height="20" class="entry-icon" />
        <span class="entry-text">
          <span class="entry-title">{{ entry.title }}</span>
          <span v-if="entry.subtitle" class="entry-subtitle">{{ entry.subtitle }}</span>
        </span>
        <span v-if="entry.value" class="entry-value">{{ entry.value }}</span>
      </button>
    </nav>

    <div class="footer">
      <button type="button" class="logout" @click="confirmOpen = true">退出登录</button>
    </div>
  </div>

  <Sheet v-model="confirmOpen" title="退出登录">
    <p class="confirm-text">退出后需要重新登录才能同步歌单与听歌记录，确定退出吗？</p>
    <template #footer>
      <div class="confirm-actions">
        <button type="button" class="ghost-button" @click="confirmOpen = false">取消</button>
        <button type="button" class="danger-button" @click="doLogout">退出</button>
      </div>
    </template>
  </Sheet>
</template>

<style scoped>
.profile-page {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.account {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-5) var(--sp-4);
}

.avatar {
  flex: 0 0 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
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

.account-text {
  min-width: 0;
}

.account-name {
  margin: 0 0 2px;
  font-size: var(--font-xl);
  font-weight: var(--weight-bold);
}

.account-id {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.entries {
  display: flex;
  flex-direction: column;
  padding: var(--sp-2) var(--sp-2);
}

.entry {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  min-height: 60px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-md);
  text-align: left;
}

.entry:active {
  background: var(--fill-subtle);
}

.entry-icon {
  flex: 0 0 auto;
  color: var(--text-secondary);
}

.entry-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.entry-title {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.entry-subtitle {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.entry-value {
  flex: 0 0 auto;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.footer {
  flex: 1;
  display: flex;
  align-items: flex-end;
  padding: var(--sp-6) var(--sp-4) var(--sp-6);
}

.logout {
  width: 100%;
  min-height: 48px;
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  color: var(--danger);
  background: var(--fill-subtle);
}

.logout:active {
  background: var(--fill-muted);
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
