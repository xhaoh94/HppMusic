<script setup lang="ts">
/**
 * 我的。
 *
 * P0 只做「账号 + 设置入口 + 退出登录」这三件真正能用的事，
 * 不铺一排点了没反应的图标（那是最容易被当成"做坏了"的形态）。
 */
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconAlbum, iconFavorite, iconSettings, iconUser } from '@mobile/icons';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import Sheet from '@mobile/components/Sheet.vue';

const router = useRouter();
const user = useUserStore();
const toast = useToastStore();

const confirmOpen = ref(false);

const nickname = computed(() => user.info?.nickname || user.info?.username || '未登录');
const avatar = computed(() => String(user.info?.pic || ''));
const userId = computed(() => String(user.info?.userid ?? ''));

/** P2 接入的入口；先列出但明确标注，而不是让点击静默失败 */
const pendingEntries = [
  { key: 'favorites', title: '我的收藏', icon: iconFavorite },
  { key: 'history', title: '播放历史', icon: iconAlbum },
];

const onPending = (title: string) => {
  toast.info(`「${title}」将在歌单与播放接入后开放`);
};

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
        v-for="entry in pendingEntries"
        :key="entry.key"
        type="button"
        class="entry"
        @click="onPending(entry.title)"
      >
        <Icon :icon="entry.icon" width="20" height="20" class="entry-icon" />
        <span class="entry-title">{{ entry.title }}</span>
        <span class="entry-note">即将开放</span>
      </button>

      <button type="button" class="entry" @click="router.push({ name: 'settings' })">
        <Icon :icon="iconSettings" width="20" height="20" class="entry-icon" />
        <span class="entry-title">设置</span>
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
  min-height: 56px;
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

.entry-title {
  flex: 1;
  min-width: 0;
  font-size: var(--font-md);
}

.entry-note {
  flex: 0 0 auto;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
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
