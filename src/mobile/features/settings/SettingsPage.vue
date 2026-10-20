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
import { computed, onMounted, ref } from 'vue';import PageHeader from '@mobile/components/PageHeader.vue';
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
import { useAppUpdate } from '@mobile/composables/useAppUpdate';
import { formatBytes } from '@mobile/adapters/appUpdate';

const setting = useSettingStore();
const lyric = useLyricStore();
const toast = useToastStore();

const version = ref('');

/* ── 更新 ── */
const update = useAppUpdate();
const updateOpen = ref(false);

/** 关于分区里「检查更新」右侧提示：不失败时不刷红色，只给一句状态。 */
const updateHint = computed(() => {
  switch (update.phase.value) {
    case 'checking':
      return '检查中…';
    case 'available':
    case 'downloading':
    case 'paused':
    case 'downloaded':
      return update.info.value?.version ?? '';
    case 'latest':
      return '已是最新';
    default:
      return '';
  }
});

const openUpdate = async () => {
  updateOpen.value = true;
  // 已经在下载/已下载时再点开不需要重新检查（会把进度状态冲掉）。
  if (['downloading', 'paused', 'downloaded'].includes(update.phase.value)) return;
  await update.check({
    currentVersion: version.value,
    includePrerelease: setting.checkPrerelease,
    proxyUrl: setting.githubProxyUrl,
  });
};

const startUpdateDownload = () => void update.download();
const installUpdate = () => void update.install();

const updateSizeText = computed(() => formatBytes(update.totalBytes.value || update.info.value?.size || 0));
const updateDownloadedText = computed(() => formatBytes(update.downloadedBytes.value));

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

/** 移动端自己的 localStorage 偏好（不归 storage 桥的 echo.mobile.* 命名空间管） */
const MOBILE_PREFERENCE_KEYS = ['hpp.theme', 'hpp.homeTabs', 'hppmusic:playback-prefs'];

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
    // 桥只清自己的 `echo.mobile.*` 命名空间；移动端自有的三个偏好用的是 hpp 前缀，
    // 不在这里一并删掉的话，重载后主题/同时播放/页签配置都还在，用户会以为“没清掉”。
    for (const key of MOBILE_PREFERENCE_KEYS) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* 单个 key 删不掉不影响整体流程 */
      }
    }
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

      <SettingsSection title="播放" default-collapsed>
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

      <SettingsSection title="音质" default-collapsed>
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

      <SettingsSection title="歌词" default-collapsed>
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

      <!--
        末尾这两组标题已恢复（用户要求）；所有分组都可点击标题折叠。
      -->
      <SettingsSection title="数据" default-collapsed>
        <ActionRow
          tone="danger"
          label="清除本地数据"
          @click="resetOpen = true"
        />
      </SettingsSection>

      <SettingsSection title="关于" default-collapsed>
        <ActionRow label="版本" :value="version || '—'" disabled />
        <ActionRow label="检查更新" :value="updateHint" @click="openUpdate" />
        <ActionRow label="平台" value="Android" disabled />
      </SettingsSection>

      <p class="legal">
        本应用基于公开接口开发的第三方音乐客户端，仅供个人学习与技术研究使用。
        音频与图文内容均来自原平台，版权归原作者及平台所有，请支持正版。
      </p>
    </div>
  </div>

  <Sheet v-model="updateOpen" title="应用更新">
    <div class="update-body">
      <p v-if="update.phase.value === 'checking'" class="confirm-text">正在检查更新…</p>

      <p v-else-if="update.phase.value === 'latest'" class="confirm-text">
        已是最新版本（当前 {{ version || '—' }}）
      </p>

      <p v-else-if="update.phase.value === 'error' && !update.info.value" class="confirm-text">
        {{ update.error.value || '检查更新失败' }}
      </p>

      <template v-else-if="update.info.value">
        <p class="update-version">新版本 {{ update.info.value.version }}</p>
        <p class="update-meta">
          <span v-if="updateSizeText">{{ updateSizeText }}</span>
          <span v-if="update.info.value.publishedAt">· {{ update.info.value.publishedAt.slice(0, 10) }}</span>
        </p>

        <div v-if="['downloading', 'paused', 'downloaded'].includes(update.phase.value)" class="progress">
          <div class="progress-track">
            <div class="progress-fill" :style="{ width: `${update.percent.value}%` }" />
          </div>
          <p class="progress-text">
            <span v-if="update.phase.value === 'downloaded'">下载完成</span>
            <span v-else-if="update.phase.value === 'paused'">等待网络，系统会自动续传</span>
            <span v-else>{{ update.percent.value }}%</span>
            <span v-if="update.phase.value !== 'downloaded'">
              {{ updateDownloadedText }} / {{ updateSizeText }}
            </span>
          </p>
        </div>

        <p v-if="update.phase.value === 'error'" class="update-error">
          {{ update.error.value }}
        </p>

        <pre v-if="update.info.value.notes && update.phase.value === 'available'" class="update-notes">{{
          update.info.value.notes
        }}</pre>
      </template>
    </div>

    <template #footer>
      <div class="confirm-actions">
        <button type="button" class="ghost-button" @click="updateOpen = false">关闭</button>
        <button
          v-if="update.phase.value === 'downloaded'"
          type="button"
          class="primary-button"
          @click="installUpdate"
        >
          安装
        </button>
        <button
          v-else-if="update.phase.value === 'downloading' || update.phase.value === 'paused'"
          type="button"
          class="primary-button"
          @click="updateOpen = false"
        >
          后台下载
        </button>
        <button
          v-else-if="update.phase.value === 'available' || (update.phase.value === 'error' && update.info.value)"
          type="button"
          class="primary-button"
          @click="startUpdateDownload"
        >
          {{ update.phase.value === 'error' ? '重新下载' : '下载并安装' }}
        </button>
        <button
          v-else-if="!update.info.value && update.phase.value !== 'checking'"
          type="button"
          class="primary-button"
          @click="openUpdate"
        >
          重新检查
        </button>
      </div>
    </template>
  </Sheet>

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
.danger-button,
.primary-button {
  /* 三个按钮共用一套尺寸：不然「下载并安装」这种长文案会溢出按钮底色（用户截图） */
  flex: 1 1 0;
  min-width: 0;
  min-height: 48px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  font-weight: var(--weight-medium);
  white-space: nowrap;
  text-align: center;
}

.ghost-button {
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

.danger-button {
  color: #fff;
  background: var(--danger);
}

.primary-button {
  color: var(--accent-on);
  background: var(--accent);
}

.primary-button:active {
  filter: brightness(0.94);
}


/* ── 更新面板 ── */
.update-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.update-version {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.update-meta {
  margin: 0;
  display: flex;
  gap: var(--sp-2);
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.update-error {
  margin: 0;
  font-size: var(--font-sm);
  color: var(--danger);
}

.progress {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.progress-track {
  height: 6px;
  border-radius: var(--radius-pill);
  background: var(--fill-muted);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width var(--duration-normal) var(--ease-standard);
}

.progress-text {
  display: flex;
  justify-content: space-between;
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.update-notes {
  margin: var(--sp-2) 0 0;
  max-height: 180px;
  overflow-y: auto;
  padding: var(--sp-3);
  border-radius: var(--radius-md);
  background: var(--fill-subtle);
  font-family: inherit;
  font-size: var(--font-sm);
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
}

.danger-button {
  color: #fff;
  background: var(--danger);
}
</style>
