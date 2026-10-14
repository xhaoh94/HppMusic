<script setup lang="ts">
/**
 * 音效面板：均衡器 + 我的音效。
 *
 * ## 只做 Android 上真正生效的两类
 *
 * · **均衡器**：原生 `EchoDspAudioProcessor` 是 10 段 peaking EQ
 *   （`31/62/125/250/500/1k/2k/4k/8k/16k` Hz，±12 dB），与这里一一对应。
 * · **我的音效**：本地导入的 WAV/IRS 卷积，原生同样有实现。
 *
 * **刻意不做的两类**（前身项目实测过的结论）：
 * · 钢琴/骨笛/尤克里里/唢呐/DJ 是上游的"重录版本"（换音源），
 *   `relate_goods` 里根本没有这些音源，取链返回 `status:1` 无地址 —— 点了不会有任何变化。
 * · 人声/伴奏虽然是原生中置算法能做的，但内核的 `setAudioEffect` 会走
 *   `refreshCurrentTrack({ seamless: true })`（无缝换源），而 Android 桥不支持
 *   `switchSource`，最终只会报「所选音效切换失败」。
 *   原生能力保留着（`setCenterChannel`），但没有可用入口 —— 要恢复得先修换源链路。
 * · VPF / 组合音效需要独立的第三方音效引擎（Provider 进程），安卓没有这个运行时。
 */
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import Sheet from '@mobile/components/Sheet.vue';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { iconRefresh } from '@mobile/icons';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const player = usePlayerStore();
const setting = useSettingStore();
const toast = useToastStore();

/** 与原生 BAND_FREQUENCIES 一一对应 */
const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
const GAIN_RANGE = 12;

const gains = ref<number[]>([...player.equalizerGains]);

watch(
  () => props.modelValue,
  (open) => {
    if (open) gains.value = [...player.equalizerGains];
  },
);

const dirty = computed(() =>
  gains.value.some((value, index) => value !== (player.equalizerGains[index] ?? 0)),
);

const onGainInput = (index: number, event: Event) => {
  const value = Number((event.target as HTMLInputElement).value);
  const next = [...gains.value];
  next[index] = Number.isFinite(value) ? value : 0;
  gains.value = next;
};

const applyEq = () => {
  player.setEq(gains.value);
  toast.success('均衡器已应用');
};

const resetEq = () => {
  gains.value = BANDS.map(() => 0);
  player.setEq(gains.value);
  toast.info('已重置为平直');
};

/* ── 我的音效 ── */
/** VPF / 组合音效需要独立音效引擎，安卓没有 → 不展示（否则会出现"下载了却用不了"） */
const usableEffects = computed(() =>
  (setting.impulseResponseFiles ?? []).filter(
    (file) => !file.vpfPath && file.kind !== 'community-vpf' && file.kind !== 'community-combined',
  ),
);

const activeEffectId = computed(() =>
  setting.impulseResponseEnabled ? String(setting.selectedImpulseResponseId ?? '') : '',
);

const selectEffect = (id: string) => {
  if (!id) {
    setting.impulseResponseEnabled = false;
    toast.info('已关闭音效');
    return;
  }
  const applied = player.selectSpatialAudioEffect(id);
  if (!applied) return;
  const file = usableEffects.value.find((item) => item.id === id);
  toast.success(`已应用「${file?.name ?? '音效'}」`);
};

const effectName = (file: { name?: string; label?: string }) => file.name || file.label || '未命名音效';
</script>

<template>
  <Sheet
    :model-value="props.modelValue"
    title="音效"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <section class="block">
      <header class="block-head">
        <h3 class="block-title">均衡器</h3>
        <button type="button" class="block-action" @click="resetEq">重置</button>
      </header>

      <div class="eq">
        <label v-for="(hz, index) in BANDS" :key="hz" class="eq-band">
          <span class="eq-value">{{ (gains[index] ?? 0) > 0 ? '+' : '' }}{{ (gains[index] ?? 0).toFixed(1) }}</span>
          <!-- 竖排滑块：10 段横排在手机上每个只有 20px 宽，手指根本按不准 -->
          <input
            class="eq-slider"
            type="range"
            :min="-GAIN_RANGE"
            :max="GAIN_RANGE"
            step="0.5"
            :value="gains[index] ?? 0"
            :aria-label="`${bandLabel(hz)}Hz 增益`"
            @input="onGainInput(index, $event)"
          />
          <span class="eq-label">{{ bandLabel(hz) }}</span>
        </label>
      </div>

      <button type="button" class="apply" :disabled="!dirty" @click="applyEq">
        {{ dirty ? '应用均衡器' : '已应用' }}
      </button>
    </section>

    <section class="block">
      <header class="block-head">
        <h3 class="block-title">我的音效</h3>
      </header>

      <button
        type="button"
        class="effect-item"
        :class="{ 'is-active': !activeEffectId }"
        @click="selectEffect('')"
      >
        <span class="effect-name">无音效</span>
      </button>

      <button
        v-for="file in usableEffects"
        :key="file.id"
        type="button"
        class="effect-item"
        :class="{ 'is-active': String(file.id) === activeEffectId }"
        @click="selectEffect(String(file.id))"
      >
        <span class="effect-name ellipsis">{{ effectName(file) }}</span>
        <Icon
          v-if="String(file.id) === activeEffectId"
          :icon="iconRefresh"
          width="0"
          height="0"
          class="hidden"
        />
      </button>

      <p v-if="!usableEffects.length" class="block-empty">
        还没有本地音效。可以在「设置」里导入 WAV / IRS 文件。
      </p>
    </section>
  </Sheet>
</template>

<style scoped>
.block + .block {
  margin-top: var(--sp-5);
  padding-top: var(--sp-4);
  border-top: 1px solid var(--divider);
}

.block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}

.block-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
}

.block-action {
  min-height: 30px;
  padding: 0 var(--sp-2);
  font-size: var(--font-sm);
  color: var(--accent);
}

/* ── 均衡器 ── */
.eq {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-1);
}

.eq-band {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
}

.eq-value {
  font-size: 10px;
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
  min-height: 12px;
}

/* 竖排 range：WebView 不认 writing-mode 的 range，要转 90 度并把容器高度掰正 */
.eq-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 110px;
  height: 20px;
  margin: 0;
  transform: rotate(-90deg) translateX(0);
  /* 旋转后视觉高度是 110px，用负外边距把它塞回 110px 高的槽位 */
  margin-block: 45px;
  background: transparent;
  touch-action: none;
}

.eq-slider::-webkit-slider-runnable-track {
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--fill-strong);
}

.eq-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 16px;
  height: 16px;
  margin-top: -6px;
  border-radius: 50%;
  background: var(--accent);
}

.eq-slider::-moz-range-track {
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--fill-strong);
}

.eq-slider::-moz-range-thumb {
  width: 16px;
  height: 16px;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
}

.eq-label {
  font-size: 10px;
  color: var(--text-tertiary);
}

.apply {
  width: 100%;
  min-height: 44px;
  margin-top: var(--sp-4);
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.apply:disabled {
  color: var(--text-tertiary);
  background: var(--fill-subtle);
}

/* ── 我的音效 ── */
.effect-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 48px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
  text-align: left;
}

.effect-item:active {
  background: var(--fill-subtle);
}

.effect-item.is-active .effect-name {
  color: var(--accent);
  font-weight: var(--weight-semibold);
}

.effect-name {
  flex: 1;
  min-width: 0;
  font-size: var(--font-md);
}

.block-empty {
  margin: var(--sp-2) 0 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.hidden {
  display: none;
}
</style>
