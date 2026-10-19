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
 *   有读取方 → autoPlayOnLaunch / volumeFade(+Time) /
 *              autoNext(+Delay/MaxAttempts) / defaultAudioQuality
 *   入口已去掉（用户要求：普通用户看不懂 LUFS，其他 App 也没有）→
 *              volumeNormalization(+Lufs)：内核仍在按 -14 LUFS 归一化（默认开），
 *              只是设置页不再暴露；lyricFilterEnabled(+Pattern) 同理（默认关闭）
 *   grep 有命中但移动端是死链（已排除）→ seekForward|BackwardOffset：
 *              EchoPlaybackService.updateSkipIntervals 是空实现，通知栏
 *              MediaSession 也没声明 FAST_FORWARD/REWIND，两个 handler 永不触发
 *   没有读取方（已排除）→ autoPlay / playbackQueueMode / showAudioQualityBadge /
 *              preventSleep / cache* / proxy* / dpi* / shortcut* / window*
 * ══════════════════════════════════════════════════════════════
 */
import { computed, onMounted, ref } from 'vue';
import PageHeader from '@mobile/components/PageHeader.vue';
import Sheet from '@mobile/components/Sheet.vue';
import SettingsSection from '@mobile/components/settings/SettingsSection.vue';
import SwitchRow from '@mobile/components/settings/SwitchRow.vue';
import { coPlayWithOthers } from '@mobile/composables/usePlaybackPrefs';
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

/* ── 音质 ── */
/** 标签沿用上游 QualityPopover 的叫法，避免同一个音质在两处叫不同名字 */
const qualityOptions: { value: AudioQualityValue; label: string }[] = [
  { value: '128', label: '标准' },
  { value: '320', label: '高品质' },
  { value: 'flac', label: '无损' },
  { value: 'high', label: 'Hi-Res' },
];

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
        />
        <SwitchRow
          v-model="setting.volumeFade"
          label="音量淡入淡出"
        />
        <SwitchRow
          v-model="setting.autoNext"
          label="播放失败自动下一首"
        />
        <SwitchRow
          v-model="coPlayWithOthers"
          label="与其他音源同时播放"
        />
      </SettingsSection>

      <SettingsSection title="音质">
        <SegmentedRow
          v-model="setting.defaultAudioQuality"
          label="默认音质"
          :options="qualityOptions"
        />
      </SettingsSection>

      <!--
        「音量」分区原来在这里：响度标准化开关 + 参考响度（-9~-18 LUFS）。
        已按用户要求整体隐藏 —— 普通用户看不懂 LUFS，其他 App 也没有这种设置。
        内核的 volumeNormalization / volumeNormalizationLufs 仍在（默认开、-14），
        行为不变；要恢复入口把这两行加回来即可。
      -->

      <SettingsSection title="歌词">
        <SegmentedRow v-model="lyricScale" label="歌词字号" :options="lyricScaleOptions" />
        <!-- 翻译/音译：写的是内核 lyric store 的 wantTranslation/wantRomanization
             （在 persist pick 列表里，切歌不重置）。store 的 lyricsMode 会自动按
             "用户意图 × 这首歌有没有译文" 推导，没有译文时开了也不显示副行。 -->
        <SwitchRow
          v-model="lyric.wantTranslation"
          label="显示翻译"
        />
        <SwitchRow
          v-model="lyric.wantRomanization"
          label="显示音译"
        />
        <SegmentedRow
          v-model="conversionMode"
          label="简繁转换"
          :options="conversionOptions"
        />
        <!--
          这里原来有「歌词过滤」（按正则隐藏行）。入口已去掉：普通用户看不懂正则，
          实测也解释不清它干嘛用。内核那套过滤逻辑还在（lyricFilterEnabled /
          lyricFilterPattern 默认关闭），要恢复只需把开关加回来。
        -->
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
