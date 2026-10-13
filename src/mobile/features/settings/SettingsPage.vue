<script setup lang="ts">
/**
 * 设置。
 *
 * 与桌面的「偏好设置」对话框毫无关系：那边是两列布局 + 悬停分区列表，
 * 手机宽度下文字会被挤成竖排。这里是全新的单页滚动列表。
 *
 * **只列出 Android 上真实生效的项**：
 * · 外观（深色/浅色/跟随系统）—— 现在就能用
 * · 版本信息 —— 现在就能用
 * 音质、音效、歌词、缓存等设置项在对应功能接入时才出现，
 * 避免出现"能点、能切、重启就没了"的假开关。
 */
import { onMounted, ref } from 'vue';
import PageHeader from '@mobile/components/PageHeader.vue';
import { setThemePreference, themePreference, type ThemePreference } from '@mobile/design/theme';

const version = ref('');

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'system', label: '跟随系统' },
];

onMounted(async () => {
  try {
    const info = await window.electron?.appInfo?.get?.();
    version.value = info?.version ? String(info.version) : '';
  } catch {
    version.value = '';
  }
});
</script>

<template>
  <div class="settings-page">
    <PageHeader title="设置" />

    <div class="settings-body scroll-y">
      <section class="group">
        <h2 class="group-title">外观</h2>
        <div class="segmented" role="radiogroup" aria-label="主题">
          <button
            v-for="option in themeOptions"
            :key="option.value"
            type="button"
            class="segment"
            :class="{ 'is-active': themePreference === option.value }"
            role="radio"
            :aria-checked="themePreference === option.value"
            @click="setThemePreference(option.value)"
          >
            {{ option.label }}
          </button>
        </div>
      </section>

      <section class="group">
        <h2 class="group-title">关于</h2>
        <div class="info-row">
          <span class="info-label">版本</span>
          <span class="info-value">{{ version || '—' }}</span>
        </div>
        <div class="info-row">
          <span class="info-label">平台</span>
          <span class="info-value">Android</span>
        </div>
        <p class="legal">
          本应用基于公开接口开发的第三方音乐客户端，仅供个人学习与技术研究使用。
          音乐内容版权归原平台及版权方所有，请支持正版。
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.settings-body {
  flex: 1;
  min-height: 0;
  padding-bottom: var(--sp-8);
}

.group {
  padding: var(--sp-4);
}

.group-title {
  margin: 0 0 var(--sp-3);
  font-size: var(--font-sm);
  font-weight: var(--weight-medium);
  color: var(--text-tertiary);
}

.segmented {
  display: flex;
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--bg-input);
}

.segment {
  flex: 1;
  min-height: 38px;
  border-radius: var(--radius-sm);
  font-size: var(--font-md);
  color: var(--text-secondary);
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}

.segment.is-active {
  color: var(--text-primary);
  background: var(--bg-overlay);
  font-weight: var(--weight-semibold);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 44px;
  border-bottom: 1px solid var(--divider);
}

.info-label {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.info-value {
  font-size: var(--font-md);
  color: var(--text-tertiary);
}

.legal {
  margin: var(--sp-4) 0 0;
  font-size: var(--font-xs);
  line-height: 1.7;
  color: var(--text-tertiary);
}
</style>
