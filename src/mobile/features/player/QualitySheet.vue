<script setup lang="ts">
/**
 * 音质选择面板。
 *
 * ## 置灰判定：两套来源，上游实际拒绝优先
 *
 * 1. **权限接口**（`/privilege/lite` → `songQualityAccess`）给的是"名义上你有没有资格"。
 *    但它会误判：账号持有概念版 VIP 时，320/无损 的 `require_vip_type` 是 `concept`，
 *    共享的判定会认为"已有概念版 VIP → 可以获取"，于是**不置灰**；
 *    而实际取链接口对这两档返回 `status=2`（需要付费），点了只会静默降级回 128。
 * 2. **上游实际拒绝的记账**（`window.__echoQualityDenied`，由桥接层在每次取链后写入）。
 *    这是唯一可靠的事实来源，所以它优先。
 *
 * ⚠️ 记账的 key 是**取链用的 hash**，不是歌曲主 hash：
 * 每档音质在 `relateGoods` 里各有自己的 hash（实测 320 用的是 `4f7184…`，
 * 而歌曲主 hash 是 `db01b9…`），只查主 hash 永远查不到。
 * 这段结论来自前身项目的实测，照搬不改。
 */
import { computed, onMounted, ref, watch } from 'vue';
import Sheet from '@mobile/components/Sheet.vue';
import { usePlayerStore } from '@/stores/player';
import { useSongQualityAccessStore, songQualityResourceKey } from '@/stores/songQualityAccess';
import { useSettingStore } from '@/stores/setting';
import { getPlaybackQualityAccessReason } from '@/utils/songQualityAccess';
import { useToastStore } from '@/stores/toast';
import type { AudioQualityValue } from '@/types';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const player = usePlayerStore();
const qualityAccess = useSongQualityAccessStore();
const setting = useSettingStore();
const toast = useToastStore();

/** 只放移动端有意义的四档；蝰蛇系列需要超级 VIP 且上游常驻不可用 */
const QUALITIES: { value: AudioQualityValue; label: string; badge: string }[] = [
  { value: '128', label: '标准音质', badge: 'SD' },
  { value: '320', label: '高品质', badge: 'HQ' },
  { value: 'flac', label: '无损音质', badge: 'SQ' },
  { value: 'high', label: 'Hi-Res', badge: 'HR' },
];

const track = computed(() => player.currentTrackSnapshot);

/** 记账表：`window.__echoQualityDenied[hash][quality] = 原因` */
const deniedMap = () =>
  (window as unknown as { __echoQualityDenied?: Record<string, Record<string, string>> })
    .__echoQualityDenied ?? {};

const accessEntry = computed(() => {
  const current = track.value;
  if (!current?.hash) return null;
  const key = songQualityResourceKey(String(current.hash), current.albumId);
  return qualityAccess.entries.get(key) ?? null;
});

const currentQuality = computed<AudioQualityValue>(() => {
  const override = (player as unknown as { currentAudioQualityOverride?: AudioQualityValue | null })
    .currentAudioQualityOverride;
  return override ?? setting.defaultAudioQuality;
});

/** 置灰原因；空串表示可选 */
const reasonOf = (quality: AudioQualityValue): string => {
  const current = track.value;
  if (!current) return '';

  const map = deniedMap();
  const candidates = [String(current.hash ?? '')];
  const relate = (current.relateGoods ?? []).find(
    (item) => String(item?.quality ?? '') === String(quality),
  );
  if (relate?.hash) candidates.push(String(relate.hash));
  for (const hash of candidates) {
    const reason = map[hash.trim().toLowerCase()]?.[quality];
    if (reason) return reason;
  }

  return getPlaybackQualityAccessReason(
    quality,
    accessEntry.value?.qualities ?? null,
    qualityAccess.membership,
  );
};

const sizeOf = (quality: AudioQualityValue): string => {
  const item = accessEntry.value?.qualities?.find((entry) => entry.quality === quality);
  return item?.sizeText ?? '';
};

const loadingAccess = ref(false);

const ensureAccess = async () => {
  const current = track.value;
  if (!current?.hash) return;
  loadingAccess.value = true;
  try {
    await qualityAccess.ensure(String(current.hash), current.albumId);
  } finally {
    loadingAccess.value = false;
  }
};

const select = (quality: AudioQualityValue) => {
  const reason = reasonOf(quality);
  if (reason) {
    toast.warning(reason);
    return;
  }
  if (quality === currentQuality.value) {
    emit('update:modelValue', false);
    return;
  }
  // 只改当前曲目：默认音质在「设置 → 音质」里改，两处职责分开
  player.setCurrentAudioQualityOverride(quality);
  toast.info(`已切换到「${QUALITIES.find((item) => item.value === quality)?.label}」`);
  emit('update:modelValue', false);
};

onMounted(() => void ensureAccess());
watch(
  () => track.value?.hash,
  () => void ensureAccess(),
);
watch(
  () => props.modelValue,
  (open) => {
    if (open) void ensureAccess();
  },
);
</script>

<template>
  <Sheet
    :model-value="props.modelValue"
    title="音质"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p class="quality-note">
      实际可用音质取决于账号权限与版权方授权；无权限的档位会标明原因。
    </p>

    <div class="quality-list">
      <button
        v-for="item in QUALITIES"
        :key="item.value"
        type="button"
        class="quality-item"
        :class="{ 'is-current': item.value === currentQuality, 'is-disabled': Boolean(reasonOf(item.value)) }"
        @click="select(item.value)"
      >
        <span class="quality-badge" :class="`badge-${item.value}`">{{ item.badge }}</span>
        <span class="quality-text">
          <span class="quality-label">{{ item.label }}</span>
          <span class="quality-detail">
            {{ reasonOf(item.value) || sizeOf(item.value) || (loadingAccess ? '正在确认权限…' : '') }}
          </span>
        </span>
        <span v-if="item.value === currentQuality" class="quality-check" aria-hidden="true">✓</span>
      </button>
    </div>
  </Sheet>
</template>

<style scoped>
.quality-note {
  margin: 0 0 var(--sp-3);
  font-size: var(--font-xs);
  line-height: 1.6;
  color: var(--text-tertiary);
}

.quality-list {
  display: flex;
  flex-direction: column;
}

.quality-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 60px;
  padding: var(--sp-2) 0;
  text-align: left;
  border-radius: var(--radius-sm);
}

.quality-item + .quality-item {
  border-top: 1px solid var(--divider);
}

.quality-item:active:not(.is-disabled) {
  background: var(--fill-subtle);
}

.quality-item.is-disabled {
  opacity: 0.45;
}

.quality-badge {
  flex: 0 0 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  border-radius: var(--radius-xs);
  font-size: 11px;
  font-weight: var(--weight-bold);
  color: #fff;
  background: var(--text-tertiary);
}

/* 角标配色沿用上游 QualityPopover 的分档色 */
.badge-320 {
  background: #2f9e44;
}
.badge-flac {
  background: #1c7ed6;
}
.badge-high {
  background: #ae3ec9;
}

.quality-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.quality-label {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.quality-item.is-current .quality-label {
  color: var(--accent);
  font-weight: var(--weight-semibold);
}

.quality-detail {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.quality-check {
  flex: 0 0 auto;
  color: var(--accent);
  font-size: var(--font-md);
  font-weight: var(--weight-bold);
}
</style>
