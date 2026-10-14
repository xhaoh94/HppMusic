<script setup lang="ts">
/**
 * 设置。
 *
 * 与桌面的「偏好设置」对话框毫无关系（那边是两列布局 + 悬停分区列表，
 * 手机宽度下文字会被挤成竖排）。
 *
 * ══════════════════════════════════════════════════════════════
 * ⚠️ 只放**能被验证有读取方**的设置项。
 *
 * 内核的 setting store 有 150+ 个字段，其中大量是桌面专属（窗口、托盘、
 * 快捷键、更新、DPI、mpv 风格缓存……）。写上去的每一个开关都必须能回答
 * 「谁在读它、读完会发生什么」—— 否则就是一个能拨但没反应的假开关，
 * 用户会以为是坏了（前身项目里这类"能切、重启就没了"的开关是最多的投诉来源）。
 *
 * 核对方式（加新项前请照做）：
 *   grep -rn "settingStore\.<字段名>" src/renderer/stores src/renderer/utils
 * 有命中才写上来。本轮核对结果：
 *   有读取方 → autoPlayOnLaunch / volumeFade(+Time) / seekForward|BackwardOffset /
 *              autoNext(+Delay/MaxAttempts) / defaultAudioQuality /
 *              volumeNormalization(+Lufs) / lyricFilterEnabled(+Pattern)
 *   没有读取方（已排除）→ autoPlay / playbackQueueMode / showAudioQualityBadge /
 *              preventSleep / cache* / proxy* / dpi* / shortcut* / window*
 * ══════════════════════════════════════════════════════════════
 */
import { computed, onMounted, ref } from 'vue';
import PageHeader from '@mobile/components/PageHeader.vue';
import Sheet from '@mobile/components/Sheet.vue';
import SettingsSection from '@mobile/components/settings/SettingsSection.vue';
import SwitchRow from '@mobile/components/settings/SwitchRow.vue';
import {
  autoPlayAndOpenOnEnter,
  openPlayerOnSelect,
} from '@mobile/composables/usePlaybackPrefs';
import SegmentedRow from '@mobile/components/settings/SegmentedRow.vue';
import ActionRow from '@mobile/components/settings/ActionRow.vue';
import { setThemePreference, themePreference, type ThemePreference } from '@mobile/design/theme';
import { useSettingStore } from '@/stores/setting';
import { useLyricStore } from '@/stores/lyric';
import { useToastStore } from '@/stores/toast';
import type { AudioQualityValue } from '@/types';

const setting = useSettingStore();
const lyric = useLyricStore();
const toast = useToastStore();

const version = ref('');

/* ── 外观 ── */
const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'dark', label: '深色' },
  { value: 'light', label: '浅色' },
  { value: 'system', label: '跟随系统' },
];
const themeValue = computed({
  get: () => themePreference.value,
  set: (value: string | number) => setThemePreference(value as ThemePreference),
});

/* ── 播放 ── */
const seekOptions = [1, 3, 5, 10, 15, 30].map((value) => ({ value, label: `${value}秒` }));

/* ── 音质 ── */
/** 标签沿用上游 QualityPopover 的叫法，避免同一个音质在两处叫不同名字 */
const qualityOptions: { value: AudioQualityValue; label: string }[] = [
  { value: '128', label: '标准' },
  { value: '320', label: '高品质' },
  { value: 'flac', label: '无损' },
  { value: 'high', label: 'Hi-Res' },
];

/* ── 响度 ── */
const lufsOptions = [-9, -11, -14, -16, -18].map((value) => ({
  value,
  label: `${value} LUFS`,
}));

/* ── 歌词 ── */
const lyricScaleOptions = [0.85, 1, 1.15, 1.3].map((value) => ({
  value,
  label: `${Math.round(value * 100)}%`,
}));
const conversionOptions = [
  { value: 'none', label: '原文' },
  { value: 'simplified', label: '简体' },
  { value: 'traditional', label: '繁体' },
];

const lyricScale = computed({
  get: () => lyric.fontScale,
  set: (value: string | number) => lyric.updateFontScale(Number(value)),
});
const conversionMode = computed({
  get: () => lyric.textConversionMode,
  set: (value: string | number) => lyric.setTextConversionMode(value),
});

/* ── 数据 / 关于 ── */
const resetOpen = ref(false);

const clearSearchHistory = () => {
  if (!setting.searchHistory.length) {
    toast.info('搜索历史已经是空的');
    return;
  }
  setting.clearSearchHistory();
  toast.success('已清空搜索历史');
};

/**
 * 清除全部本地数据。
 *
 * 走桥的 `storage.resetAll()`：它清的是 localStorage 里**本应用命名空间**下的键
 * （`echo.mobile.kv.*` 与队列/历史快照），不动 WebView 的其他存储。
 * 清完必须 reload —— 内存里的 pinia 还持有旧状态，不重载会出现"清完了但界面没变"。
 */
const resetAll = async () => {
  resetOpen.value = false;
  try {
    await window.electron?.storage?.resetAll?.();
    toast.success('已清除本地数据，即将重启界面');
    window.setTimeout(() => window.location.reload(), 600);
  } catch (error) {
    toast.danger(error instanceof Error ? error.message : '清除失败');
  }
};

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
      <SettingsSection title="外观">
        <SegmentedRow v-model="themeValue" label="主题" :options="themeOptions" />
      </SettingsSection>

      <SettingsSection title="播放">
        <SwitchRow
          v-model="setting.autoPlayOnLaunch"
          label="启动时自动播放"
          description="打开应用后自动恢复上次的播放"
        />
        <SwitchRow
          v-model="setting.volumeFade"
          label="音量淡入淡出"
          description="切歌与暂停时平滑过渡，避免爆音"
        />
        <SwitchRow
          v-model="setting.autoNext"
          label="播放失败自动下一首"
          description="当前曲目无法播放时自动跳过"
        />
        <!--
          下面两项是**移动端自己的偏好**（存在 localStorage，不在内核 setting 里——
          那是只读 vendor）。它们只影响歌曲列表页（目前是随便听）的跳转行为。
        -->
        <SwitchRow
          v-model="autoPlayAndOpenOnEnter"
          label="进入页面时自动播"
          description="仅本次会话首次切入随便听时触发；之后进入停在列表，不会打断你手动暂停"
        />
        <SwitchRow
          v-model="openPlayerOnSelect"
          label="点歌后进播放页"
          description="在列表里点一首歌后直接打开播放页；关着则留在列表方便连试"
        />
        <SegmentedRow
          v-model="setting.seekForwardOffset"
          label="快进步长"
          :options="seekOptions"
        />
        <SegmentedRow
          v-model="setting.seekBackwardOffset"
          label="快退步长"
          :options="seekOptions"
        />
      </SettingsSection>

      <SettingsSection
        title="音质"
        description="实际可用音质取决于账号权限；无权限时会自动降级到可播放的音质。"
      >
        <SegmentedRow
          v-model="setting.defaultAudioQuality"
          label="默认音质"
          :options="qualityOptions"
        />
      </SettingsSection>

      <SettingsSection title="音量">
        <SwitchRow
          v-model="setting.volumeNormalization"
          label="响度标准化"
          description="按参考响度调整每首歌的音量，避免忽大忽小"
        />
        <SegmentedRow
          v-model="setting.volumeNormalizationLufs"
          label="参考响度"
          :options="lufsOptions"
          :disabled="!setting.volumeNormalization"
        />
      </SettingsSection>

      <SettingsSection title="歌词">
        <SegmentedRow v-model="lyricScale" label="歌词字号" :options="lyricScaleOptions" />
        <SegmentedRow
          v-model="conversionMode"
          label="简繁转换"
          :options="conversionOptions"
        />
        <SwitchRow
          v-model="setting.lyricFilterEnabled"
          label="歌词过滤"
          description="按正则隐藏匹配到的行（如作词/作曲等元信息）"
        />
        <div v-if="setting.lyricFilterEnabled" class="filter-input-row">
          <input
            v-model="setting.lyricFilterPattern"
            class="filter-input"
            type="text"
            autocapitalize="off"
            autocomplete="off"
            placeholder="正则，例如：^(作词|作曲|编曲)"
          />
          <p class="filter-hint">留空则不隐藏任何行</p>
        </div>
      </SettingsSection>

      <SettingsSection title="数据">
        <ActionRow
          label="清空搜索历史"
          :value="`${setting.searchHistory.length} 条`"
          @click="clearSearchHistory"
        />
        <ActionRow
          tone="danger"
          label="清除本地数据"
          description="设置、播放队列、播放历史与登录状态都会清空"
          @click="resetOpen = true"
        />
      </SettingsSection>

      <SettingsSection title="关于">
        <ActionRow label="版本" :value="version || '—'" disabled />
        <ActionRow label="平台" value="Android" disabled />
      </SettingsSection>

      <p class="legal">
        本应用基于公开接口开发的第三方音乐客户端，仅供个人学习与技术研究使用。
        音频与图文内容均来自原平台，版权归原作者及平台所有，请支持正版。
      </p>
    </div>
  </div>

  <Sheet v-model="resetOpen" title="清除本地数据">
    <p class="confirm-text">
      将清空设置、播放队列、播放历史与登录状态，且不可恢复。确定继续吗？
    </p>
    <template #footer>
      <div class="confirm-actions">
        <button type="button" class="ghost-button" @click="resetOpen = false">取消</button>
        <button type="button" class="danger-button" @click="resetAll">清除</button>
      </div>
    </template>
  </Sheet>
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

.filter-input-row {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: 0 0 var(--sp-3);
}

.filter-input {
  height: 44px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-sm);
  border: 1px solid var(--divider);
  background: var(--bg-input);
  font-size: var(--font-sm);
  outline: none;
}

.filter-input:focus {
  border-color: var(--accent);
}

.filter-hint {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.legal {
  margin: var(--sp-4) 0 0;
  padding: 0 var(--sp-4);
  font-size: var(--font-xs);
  line-height: 1.7;
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
