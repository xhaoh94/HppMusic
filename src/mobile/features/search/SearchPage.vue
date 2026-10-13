<script setup lang="ts">
/**
 * 搜索。
 *
 * P2 接入：热搜、搜索历史、多 Tab 结果（单曲/歌手/专辑/歌单/歌词）。
 * P0 先做一个**可用的输入框** —— 桌面端的搜索框在标题栏里，移动端标题栏被隐藏后
 * 页面里根本没地方输入（旧方案是往上游搜索页注入一个输入栏来补救）。
 * 这里从一开始就是页面内的输入框，不存在这个问题。
 */
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { iconSearch, iconClose } from '@mobile/icons';
import PageHeader from '@mobile/components/PageHeader.vue';
import EmptyState from '@mobile/components/EmptyState.vue';

const keyword = ref('');
const submitted = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

const submit = () => {
  const value = keyword.value.trim();
  if (!value) return;
  // P2：这里跳转到搜索结果页
  submitted.value = value;
};

const clear = () => {
  keyword.value = '';
  submitted.value = '';
  inputRef.value?.focus();
};
</script>

<template>
  <div class="search-page">
    <PageHeader title="搜索" />

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
        @keyup.enter="submit"
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

    <div class="search-body scroll-y">
      <EmptyState
        v-if="submitted"
        title="搜索结果即将上线"
        :description="`已记录关键词「${submitted}」，搜索接口将在下一步接入。`"
      />
      <EmptyState
        v-else
        title="热搜与历史即将上线"
        description="这里会展示热搜榜、搜索历史与猜你想搜。"
      />
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
  /* WebKit 的 search 输入框自带一个清除按钮，样式无法控制，关掉用自研的 */
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

.search-body {
  flex: 1;
  min-height: 0;
}
</style>
