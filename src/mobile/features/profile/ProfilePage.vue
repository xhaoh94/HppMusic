<script setup lang="ts">
/**
 * 我的。
 *
 * ## 版式对齐参考产品（`EchoMusicMobile/src/renderer/views/Profile.vue`）
 *
 * 三段卡片：
 * 1. **身份** —— 头像 + 昵称 + 会员/地域标签 + 个性签名，下面是等级与社交计数
 * 2. **档案** —— 用户 ID / 性别 / 乐龄 / 所在地区 / 累计听歌，再接四张会员卡
 * 3. **入口** —— 收藏 / 歌单 / 历史 / 设置，最后退出登录
 *
 * 之前在"我的"页只有头像 + ID + 四个入口，把用户档案整块省掉了 —— 参考产品那一屏
 * 承载的信息（乐龄、累计听歌、会员到期）恰恰是用户会来看的东西。
 *
 * ## 数据没有新增接口
 *
 * 全部来自 store 里已有的 `user.info`：登录时 `handleLoginSuccess` 已经并行调了
 * `getUserDetail` / `getUserVipDetail` / `getUserInfo` 并合并进 `info.detail` / `info.vip`。
 * 只有"等级明细"（`fetchGradeInfo`）是额外的 —— 它带 `p_current_point` 等升级进度字段，
 * 进页面时补拉一次，省得用户为了看累计听歌还要先点一下等级。
 *
 * ⚠️ 别把「未加载」显示成 0
 *
 * 社交计数（好友/关注/粉丝/访客）没拉到档案时一律显示 `—`：显示 0 会被读成
 * "确实一个都没有"，与"还没拉取"是两件事。只有 `hasDetail` 为真才显示数字。
 *
 * ## 社交计数是纯展示，不是按钮
 *
 * 参考产品点这些计数会打开好友/关注/粉丝/访客列表。移动端这四个列表还没有实现，
 * 所以这里**不做成可点的**（不放箭头、不加按压反馈）—— 铺一排点了没反应的入口
 * 是这个项目从一开始就在避免的事。要列表的话得先实现列表本身。
 */
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import {
  iconAlbum,
  iconDiamond,
  iconFavorite,
  iconHistory,
  iconSettings,
  iconUser,
} from '@mobile/icons';
import { useUserStore } from '@/stores/user';
import { usePlaylistStore } from '@/stores/playlist';
import { useHistoryStore } from '@/stores/historyStore';
import { useToastStore } from '@/stores/toast';
import { useProfileSummary, type MembershipKind } from '@mobile/adapters/profile';
import Sheet from '@mobile/components/Sheet.vue';

const router = useRouter();
const user = useUserStore();
const playlist = usePlaylistStore();
const history = useHistoryStore();
const toast = useToastStore();

const summary = useProfileSummary();

const confirmOpen = ref(false);
const avatarFailed = ref(false);

const avatar = computed(() => {
  const url = summary.value.avatarUrl;
  return url && !avatarFailed.value ? url : '';
});

/** 会员卡的图标配色（模板里是 `is-{kind}`，四种颜色在下方 CSS 里） */
const membershipTone: Record<MembershipKind, string> = {
  super: 'tone-super',
  deluxe: 'tone-deluxe',
  concept: 'tone-concept',
  music: 'tone-music',
};

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

onMounted(() => {
  // 等级明细带 p_current_point / d_sec，补拉一次让"累计听歌"直接可见。
  // store 内部按账号代次做了防串号，重复进页面再调也是安全的。
  if (!user.isLoggedIn) return;
  void user.fetchGradeInfo().catch(() => undefined);
});
</script>

<template>
  <div class="profile-page scroll-y">
    <!-- ① 身份 -->
    <section class="card identity">
      <div class="identity-head">
        <div class="avatar">
          <img v-if="avatar" :src="avatar" alt="" @error="avatarFailed = true" />
          <Icon v-else :icon="iconUser" width="28" height="28" />
        </div>
        <div class="identity-copy">
          <div class="name-line">
            <h2 class="name ellipsis">{{ summary.nickname }}</h2>
            <span v-if="summary.vipLabel" class="badge" :class="`is-${summary.vipKind}`">
              {{ summary.vipLabel }}
            </span>
            <span v-if="summary.regionTag" class="badge is-region">{{ summary.regionTag }}</span>
          </div>
          <p v-if="summary.signature" class="signature ellipsis">{{ summary.signature }}</p>
        </div>
      </div>

      <dl class="stats">
        <div class="stat">
          <dt class="stat-value">
            Lv.{{ summary.grade ?? '—' }}
          </dt>
          <dd class="stat-label">等级</dd>
        </div>
        <div class="stat">
          <dt class="stat-value">{{ summary.hasDetail ? summary.friends : '—' }}</dt>
          <dd class="stat-label">好友</dd>
        </div>
        <div class="stat">
          <dt class="stat-value">{{ summary.hasDetail ? summary.follows : '—' }}</dt>
          <dd class="stat-label">关注</dd>
        </div>
        <div class="stat">
          <dt class="stat-value">{{ summary.hasDetail ? summary.fans : '—' }}</dt>
          <dd class="stat-label">粉丝</dd>
        </div>
        <div class="stat">
          <dt class="stat-value">{{ summary.hasDetail ? summary.visitors : '—' }}</dt>
          <dd class="stat-label">访客</dd>
        </div>
      </dl>
    </section>

    <!-- ② 档案 + 会员 -->
    <section class="card">
      <dl class="facts">
        <div class="fact">
          <dt>用户 ID</dt>
          <dd class="ellipsis">{{ summary.userId || '—' }}</dd>
        </div>
        <div class="fact">
          <dt>性别</dt>
          <dd>{{ summary.gender }}</dd>
        </div>
        <div class="fact">
          <dt>乐龄</dt>
          <dd>{{ summary.accountAge }}</dd>
        </div>
        <div class="fact">
          <dt>所在地区</dt>
          <dd class="ellipsis">{{ summary.location }}</dd>
        </div>
        <div class="fact is-wide">
          <dt>累计听歌</dt>
          <dd>{{ summary.listening }}</dd>
        </div>
      </dl>

      <div class="memberships">
        <article
          v-for="item in summary.memberships"
          :key="item.key"
          class="membership"
          :class="membershipTone[item.kind]"
        >
          <Icon :icon="iconDiamond" width="18" height="18" class="membership-icon" />
          <div class="membership-copy">
            <h4 class="membership-label">{{ item.label }}</h4>
            <p class="membership-expiry">{{ item.active ? item.expiry || '已开通' : '未开通' }}</p>
          </div>
        </article>
      </div>
    </section>

    <!-- ③ 入口 -->
    <nav class="card entries">
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
  padding: var(--sp-3) var(--sp-3) var(--sp-6);
}

.card {
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
}

.card + .card {
  margin-top: var(--sp-3);
}

/* ── ① 身份 ── */
.identity {
  padding: var(--sp-4) var(--sp-4) var(--sp-3);
}

.identity-head {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}

.avatar {
  flex: 0 0 60px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
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

.identity-copy {
  flex: 1;
  min-width: 0;
}

.name-line {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}

.name {
  margin: 0;
  font-size: var(--font-xl);
  font-weight: var(--weight-bold);
  color: var(--text-primary);
}

.badge {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  font-size: var(--font-xs);
  line-height: 16px;
  color: #fff;
  background: var(--fill-strong);
}

/* 会员标识按档位分色（与参考产品一致：超级金 / 豪华金 / 概念紫 / 畅听绿） */
.badge.is-super,
.badge.is-deluxe {
  background: #c8a24a;
}

.badge.is-concept {
  background: #7b61d8;
}

.badge.is-music {
  background: #2f9e6e;
}

.badge.is-region {
  color: var(--text-secondary);
  background: var(--fill-muted);
}

.signature {
  margin: 4px 0 0;
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.stats {
  display: flex;
  align-items: stretch;
  margin: var(--sp-4) 0 0;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--divider);
}

.stat {
  flex: 1;
  min-width: 0;
  text-align: center;
}

/* 分隔竖线用 border-left，比额外元素干净；第一项不要 */
.stat + .stat {
  border-left: 1px solid var(--divider);
}

.stat-value {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.stat-label {
  margin: 2px 0 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

/* ── ② 档案 ── */
.facts {
  display: grid;
  grid-template-columns: 1fr 1fr;
  margin: 0;
  padding: var(--sp-4) var(--sp-4) var(--sp-2);
}

.fact {
  min-width: 0;
  padding: var(--sp-2) 0;
}

.fact.is-wide {
  grid-column: 1 / -1;
}

.fact dt {
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.fact dd {
  margin: 3px 0 0;
  font-size: var(--font-md);
  color: var(--text-primary);
}

.memberships {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
  margin: 0 var(--sp-4);
  padding: var(--sp-3) 0 var(--sp-4);
  border-top: 1px solid var(--divider);
}

.membership {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}

.membership-icon {
  flex: 0 0 auto;
}

.tone-super .membership-icon,
.tone-deluxe .membership-icon {
  color: #c8a24a;
}

.tone-concept .membership-icon {
  color: #7b61d8;
}

.tone-music .membership-icon {
  color: #2f9e6e;
}

.membership-copy {
  min-width: 0;
}

.membership-label {
  margin: 0;
  font-size: var(--font-md);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
}

.membership-expiry {
  margin: 2px 0 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

/* ── ③ 入口 ── */
.entries {
  display: flex;
  flex-direction: column;
  padding: var(--sp-1) var(--sp-2);
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
  font-size: var(--font-lg);
  color: var(--text-primary);
}

.entry-subtitle {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.entry-value {
  flex: 0 0 auto;
  font-size: var(--font-md);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.footer {
  padding: var(--sp-5) var(--sp-1) 0;
}

.logout {
  width: 100%;
  min-height: 48px;
  border-radius: var(--radius-md);
  font-size: var(--font-lg);
  color: var(--danger);
  background: var(--bg-raised);
}

.logout:active {
  background: var(--fill-subtle);
}

.confirm-text {
  margin: var(--sp-2) 0 var(--sp-4);
  font-size: var(--font-md);
  line-height: var(--leading-normal);
  color: var(--text-secondary);
}

.confirm-actions {
  display: flex;
  gap: var(--sp-3);
}

.ghost-button,
.danger-button {
  flex: 1;
  min-height: 46px;
  border-radius: var(--radius-md);
  font-size: var(--font-lg);
}

.ghost-button {
  color: var(--text-primary);
  background: var(--fill-muted);
}

.danger-button {
  color: var(--accent-on);
  background: var(--danger);
}
</style>
