<script setup lang="ts">
/**
 * 搜索页。
 *
 * 一个路由两种状态：`?q=` 为空时是**发现页**（搜索历史 + 热搜），
 * 有值时是**结果页**。桌面端也是这个模型。
 *
 * 为什么输入框在页面里而不是标题栏：桌面端的搜索框在标题栏，移动端标题栏
 * 整个被隐藏了 —— 前身项目因此要往上游搜索页里注入一个输入栏来补救。
 * 这里从一开始就是页面内输入框，不存在这个问题。
 *
 * 搜索历史直接用内核 `settingStore`（它自带持久化与去重、上限 20 条），
 * 不在移动端另存一份 —— 两份历史必然不同步。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import EmptyState from '@mobile/components/EmptyState.vue';
import SearchResults from './SearchResults.vue';
import { getHotCategories, type HotCategory } from '@mobile/adapters/search';
import { useSettingStore } from '@/stores/setting';
import logger from '@/utils/logger';
import { iconClose, iconSearch, iconRemove } from '@mobile/icons';

const route = useRoute();
const router = useRouter();
const setting = useSettingStore();

const keyword = ref(String(route.query.q ?? ''));
const inputRef = ref<HTMLInputElement | null>(null);

/** 当前生效的搜索词（来自路由，而不是输入框 —— 输入框可以边打字边过滤） */
const activeKeyword = computed(() => String(route.query.q ?? '').trim());

const hotCategories = ref<HotCategory[]>([]);
const hotState = ref<'loading' | 'ready' | 'error'>('loading');
const hotError = ref('');

const history = computed(() => setting.searchHistory ?? []);
/** 热搜只需要第一个分类（手机一屏放不下 30 条），其余分类交给「排行榜」 */
const primaryHot = computed(() => hotCategories.value[0]?.keywords ?? []);

const loadHot = async () => {
  hotState.value = 'loading';
  hotError.value = '';
  try {
    const categories = await getHotCategories();
    hotCategories.value = categories;
    hotState.value = 'ready';
  } catch (error) {
    logger.warn('Search', 'Load hot categories failed', error);
    hotError.value = error instanceof Error ? error.message : String(error);
    hotState.value = 'error';
  }
};

const submit = (value?: string) => {
  const next = (value ?? keyword.value).trim();
  if (!next) return;
  keyword.value = next;
  setting.addToSearchHistory(next);
  // 同词重复搜索也要重新触发（replace 到同一个 query 不会触发 watch）
  if (activeKeyword.value === next) {
    void router.replace({ name: 'search', query: { q: next }, force: true });
    return;
  }
  void router.push({ name: 'search', query: { q: next } });
};

const clear = () => {
  keyword.value = '';
  void router.replace({ name: 'search' });
  inputRef.value?.focus();
};

const removeHistory = (value: string) => {
  setting.removeFromSearchHistory(value);
};

const clearHistory = () => {
  setting.clearSearchHistory();
};

// 从别处跳进来（如主页搜索磁贴）时同步输入框
watch(
  () => route.query.q,
  (value) => {
    keyword.value = String(value ?? '');
  },
);

onMounted(() => {
  void loadHot();
  // 未搜索时自动聚焦（键盘弹不弹由系统决定，不强行调 focus 以免跳动）
  if (!activeKeyword.value) inputRef.value?.focus();
});
</script>

<template>
  <div class="search-page">
    <div class="search-bar">
      <Icon :icon="iconSearch" width="18" height="18" class="search-icon" />
      <input
        ref="inputRef"
        v-model="keyword"
        class="search-input"
        type="search"
        enterkeyhint="search"
        autocapitalize="off"
        autocomplete="off"
        placeholder="搜索音乐、歌手、专辑"
        aria-label="搜索音乐、歌手、专辑"
        @keyup.enter="submit()"
      />
      <button
        v-if="keyword"
        type="button"
        class="clear-button"
        aria-label="清空搜索词"
        @click="clear"
      >
        <Icon :icon="iconClose" width="16" height="16" />
      </button>
    </div>

    <SearchResults v-if="activeKeyword" :key="activeKeyword" :keywords="activeKeyword" />

    <div v-else class="discovery scroll-y">
      <section v-if="history.length" class="section">
        <header class="section-header">
          <h2 class="section-title">搜索历史</h2>
          <button type="button" class="section-action" @click="clearHistory">清空</button>
        </header>
        <div class="chips">
          <span v-for="item in history" :key="item" class="chip">
            <button type="button" class="chip-text" @click="submit(item)">{{ item }}</button>
            <button
              type="button"
              class="chip-remove"
              :aria-label="`删除历史：${item}`"
              @click="removeHistory(item)"
            >
              <Icon :icon="iconRemove" width="12" height="12" />
            </button>
          </span>
        </div>
      </section>

      <section class="section">
        <header class="section-header">
          <h2 class="section-title">热搜榜</h2>
          <button type="button" class="section-action" @click="loadHot">刷新</button>
        </header>

        <EmptyState v-if="hotState === 'loading'" tone="loading" title="正在加载热搜" />
        <EmptyState
          v-else-if="hotState === 'error'"
          tone="error"
          title="热搜加载失败"
          :description="hotError"
          action-label="重试"
          @action="loadHot"
        />
        <ol v-else class="hot-list">
          <li v-for="(item, index) in primaryHot" :key="item.keyword">
            <button type="button" class="hot-item" @click="submit(item.keyword)">
              <span class="hot-rank" :class="{ 'is-top': index < 3 }">{{ index + 1 }}</span>
              <span class="hot-text ellipsis">{{ item.keyword }}</span>
              <span v-if="item.reason" class="hot-reason ellipsis">{{ item.reason }}</span>
            </button>
          </li>
        </ol>
      </section>
    </div>
  </div>
</template>

<style scoped>
.search-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.search-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: 44px;
  margin: 0 var(--sp-4) var(--sp-3);
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
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
  /* WebKit 的 search 输入框自带一个样式不可控的清除按钮，关掉用自研的 */
  -webkit-appearance: none;
  appearance: none;
  font-size: var(--font-md);
}

.search-input::-webkit-search-cancel-button {
  display: none;
}

.clear-button {
  flex: 0 0 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--text-tertiary);
}

.discovery {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-6);
}

.section {
  padding: var(--sp-2) var(--sp-4) var(--sp-5);
}

.section-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}

.section-title {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: var(--weight-bold);
}

.section-action {
  min-height: 32px;
  padding: 0 var(--sp-2);
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

/* ── 历史 chip ── */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}

.chip {
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-pill);
  background: var(--fill-muted);
  overflow: hidden;
}

.chip-text {
  min-height: 34px;
  padding: 0 var(--sp-2) 0 var(--sp-3);
  font-size: var(--font-sm);
  color: var(--text-primary);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 34px;
  color: var(--text-tertiary);
}

/* ── 热搜榜 ── */
.hot-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.hot-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 48px;
  text-align: left;
}

.hot-item:active {
  background: var(--fill-subtle);
}

.hot-rank {
  flex: 0 0 20px;
  text-align: center;
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.hot-rank.is-top {
  color: var(--accent);
}

.hot-text {
  flex: 1;
  min-width: 0;
  font-size: var(--font-md);
}

.hot-reason {
  flex: 0 1 40%;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
  text-align: right;
}
</style>
