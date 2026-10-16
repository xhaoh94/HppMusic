<script setup lang="ts">
/**
 * 音效面板：**均衡器 / 音效 / 音效市场** 三个页签。
 *
 * 分页签而不是一屏长列表：这三块的用法完全不同 —— 均衡器是"拧参数"、
 * 音效是"挑一个已装的"、音效市场是"逛着下载"，揉在一屏里每次都要滚半天
 * 才能找到自己要的那块，市场列表一长下面两块更没影。
 *
 * ## 各页签的能力边界（前身项目实测的结论，别重复踩）
 *
 * · **均衡器**：原生 `EchoDspAudioProcessor` 是 10 段 peaking EQ
 *   （`31/62/125/250/500/1k/2k/4k/8k/16k` Hz，±12 dB），与这里一一对应。
 * · **音效**：本地导入/市场下载的 WAV/IRS 卷积，原生同样有实现。
 *
 * **刻意不做的两类**：
 * · 钢琴/骨笛/尤克里里/唢呐/DJ 是上游的"重录版本"（换音源），
 *   `relate_goods` 里根本没有这些音源，取链返回 `status:1` 无地址 —— 点了不会有任何变化。
 * · 人声/伴奏虽然是原生中置算法能做的，但内核的 `setAudioEffect` 会走
 *   `refreshCurrentTrack({ seamless: true })`（无缝换源），而 Android 桥不支持
 *   `switchSource`，最终只会报「所选音效切换失败」。
 *   原生能力保留着（`setCenterChannel`），但没有可用入口 —— 要恢复得先修换源链路。
 * · VPF / 组合音效需要独立的第三方音效引擎（Provider 进程），安卓没有这个运行时。
 */
import { computed, ref, watch } from 'vue';
import Sheet from '@mobile/components/Sheet.vue';
import { usePlayerStore } from '@/stores/player';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import {
  getCommunityAudioEffects,
  getCommunityImpulseResponseUrls,
  getCommunityVpfUrls,
  type CommunityAudioEffect,
  type CommunityAudioEffectSort,
} from '@/api/audioEffect';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const player = usePlayerStore();
const setting = useSettingStore();
const toast = useToastStore();

/* ── 页签 ── */
const TABS = [
  { id: 'eq', label: '均衡器' },
  { id: 'mine', label: '音效' },
  { id: 'market', label: '音效市场' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const activeTab = ref<TabId>('eq');

/** 与原生 BAND_FREQUENCIES 一一对应 */
const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const bandLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : String(hz));
const GAIN_RANGE = 12;

/**
 * 预设均衡器：每档 10 个值，顺序同 BANDS。
 *
 * 数值是各类音乐的常见起手曲线（不是标准，用户大多会再手动微调）——
 * 低频和高频各抬 2~5 dB、中频按风格压或抬。全部在 ±12 dB 原生范围内。
 */
const EQ_PRESETS = [
  { id: 'flat', label: '默认', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'pop', label: '流行', gains: [3, 2, 0, -1, 0, 1, 2, 3, 2, 2] },
  { id: 'rock', label: '摇滚', gains: [5, 4, 2, 0, -1, 0, 2, 3, 4, 5] },
  { id: 'classical', label: '古典', gains: [4, 3, 1, 0, 0, 0, -1, 0, 2, 3] },
  { id: 'jazz', label: '爵士', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: 'electronic', label: '电子', gains: [4, 3, 1, 0, -1, 1, 0, 2, 3, 4] },
  { id: 'metal', label: '重金属', gains: [4, 3, 0, 0, -2, 0, 1, 3, 4, 5] },
  { id: 'folk', label: '民谣', gains: [2, 1, 0, 1, 2, 1, 0, 1, 2, 2] },
] as const;

const gains = ref<number[]>([...player.equalizerGains]);

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      gains.value = [...player.equalizerGains];
      return;
    }
    // 关上就回到第一个页签，下次打开从均衡器开始（不记住上次停在哪个页签）
    activeTab.value = 'eq';
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

/**
 * 当前曲线命中哪个预设（用于高亮）。逐档比对，容差 0.01 ——
 * 用户手动微调过就不该再算某个预设的功劳。
 */
const activePresetId = computed(() => {
  const matched = EQ_PRESETS.find((preset) =>
    preset.gains.every((value, index) => Math.abs(value - (gains.value[index] ?? 0)) < 0.01),
  );
  return matched?.id ?? '';
});

/** 点预设 = 直接应用（不等"应用均衡器"），推子跟着动 */
const applyPreset = (preset: (typeof EQ_PRESETS)[number]) => {
  if (activePresetId.value === preset.id) return;
  gains.value = [...preset.gains];
  player.setEq(gains.value);
  toast.success(`已应用「${preset.label}」`);
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

/* ── 音效市场 ──
 *
 * 数据来自内核的 `getCommunityAudioEffects()`（上游 /ocean/v6/sound/list）。
 * 下载/落盘/注册这一整条链已经在桥里实现（`window.electron.audioEffects.
 * downloadCommunityAudioEffect` → filesDir/audio-effects/*.wav），这里只做三件事：
 * 列出来（用不了的直接剔除，不置灰）、点一下下载并应用。
 */
const marketEffects = ref<CommunityAudioEffect[]>([]);
const marketLoading = ref(false);
const marketError = ref('');
/** 上游这一页总共返回了多少条（含被剔除的）—— 用来区分"没有内容"和"没有可用的" */
const marketRawCount = ref(0);
const marketTotal = ref(0);
const marketPage = ref(1);
/** 正在下载的音效 id；同时只允许一个，避免并发写同一个目录 */
const downloadingId = ref(0);
const MARKET_PAGE_SIZE = 30;

/** 排序分页：与上游 /ocean/v6/sound/list 的 sort 参数一一对应 */
const SORTS: { value: CommunityAudioEffectSort; label: string }[] = [
  { value: 2, label: '推荐' },
  { value: 3, label: '最热' },
  { value: 4, label: '最新' },
];
const marketSort = ref<CommunityAudioEffectSort>(2);

/**
 * 能不能在安卓上用。**不满足的项在加载时就被剔除**，不进列表。
 *
 * 三条排除理由，顺序即优先级：
 * · 上游 `privilege/singer_privilege > 0`（付费音效）→ 内核已给出 unavailableReason；
 * · 带 VPF 资源 → 需要独立的第三方音效引擎进程，安卓没有（含 ir+vpf 的组合音效也一并排除，
 *   只应用卷积部分会得到半个音效，不如不做）；
 * · 没有合法的卷积资源地址 → 下载了也没东西可用。
 */
const marketStatus = (effect: CommunityAudioEffect): { usable: boolean; reason: string } => {
  if (effect.unavailableReason) return { usable: false, reason: '需要付费/授权' };
  if (getCommunityVpfUrls(effect).length > 0) return { usable: false, reason: '安卓暂不支持' };
  if (getCommunityImpulseResponseUrls(effect).length === 0) {
    return { usable: false, reason: '无可用资源' };
  }
  return { usable: true, reason: '' };
};

const loadMarket = async (page = 1) => {
  if (marketLoading.value) return;
  marketLoading.value = true;
  marketError.value = '';
  try {
    // sort 2 = 推荐
    const result = await getCommunityAudioEffects(page, MARKET_PAGE_SIZE, marketSort.value);
    // 用不了的（付费/带 VPF/无卷积资源）**直接剔除**，不进列表 ——
    // 置灰版实测反馈：列表里一大半是不能点的，反而像功能坏了。
    const usable = result.items.filter((item) => marketStatus(item).usable);
    marketEffects.value = page === 1 ? usable : [...marketEffects.value, ...usable];
    marketRawCount.value =
      page === 1 ? result.items.length : marketRawCount.value + result.items.length;
    marketTotal.value = result.total;
    marketPage.value = page;
  } catch (error) {
    marketError.value = error instanceof Error ? error.message : '音效市场加载失败';
  } finally {
    marketLoading.value = false;
  }
};

// 按"已拉取的页数"判断还有没有下一页：不能用 marketEffects.length 比 total ——
// 过滤后可见条数永远小于上游总数，那样"加载更多"会在拉完之后还挂着。
const hasMoreMarket = computed(() => marketPage.value * MARKET_PAGE_SIZE < marketTotal.value);

/** 换排序 = 回到第一页重拉（三个排序的列表互不相干） */
const changeMarketSort = (sort: CommunityAudioEffectSort) => {
  if (sort === marketSort.value || marketLoading.value) return;
  marketSort.value = sort;
  void loadMarket(1);
};

const appliedMarketId = computed(() => {
  const key = activeEffectId.value;
  const matched = key.match(/^community-effect-(\d+)$/);
  return matched ? Number(matched[1]) : 0;
});

/** 与桥里下载时的 id 规则一致（`community-effect-<modelId>`） */
const marketFileId = (effect: CommunityAudioEffect) => `community-effect-${effect.id}`;

const isMarketInstalled = (effect: CommunityAudioEffect) =>
  (setting.impulseResponseFiles ?? []).some((file) => file.id === marketFileId(effect));

const applyMarketEffect = async (effect: CommunityAudioEffect) => {
  if (downloadingId.value || !marketStatus(effect).usable) return;
  const bridge = window.electron?.audioEffects;
  if (!bridge?.downloadCommunityAudioEffect) {
    toast.warning('当前环境不支持下载音效');
    return;
  }
  downloadingId.value = effect.id;
  try {
    const result = await bridge.downloadCommunityAudioEffect({
      modelId: effect.id,
      name: effect.name,
      impulseResponseUrls: getCommunityImpulseResponseUrls(effect),
      // 带 VPF 的已经在上面排除了，这里始终只要卷积资源
      vpfUrls: [],
    });
    if (!result?.file) {
      toast.warning(result?.error || '音效下载失败');
      return;
    }
    setting.addImpulseResponseFile(result.file, { select: true });
    toast.success(`已应用「${effect.name}」`);
  } finally {
    downloadingId.value = 0;
  }
};

/** 卸载：removeImpulseResponseFile 内部会清掉 filesDir 里的文件，正在用的会先退回无音效 */
const uninstallMarketEffect = (effect: CommunityAudioEffect) => {
  const id = marketFileId(effect);
  if (!isMarketInstalled(effect)) return;
  setting.removeImpulseResponseFile(id);
  toast.info(`已卸载「${effect.name}」`);
};

/**
 * 点行切换：**只对已下载的音效开放**。
 *
 * 未下载的行点了没意义（要么误触下载、要么毫无反应），所以行本身不接点击；
 * 下载过的行点一下就是"换用这个"，和「音效」页签里选一个是一回事。
 */
const selectMarketEffect = (effect: CommunityAudioEffect) => {
  if (downloadingId.value !== 0) return;
  const id = marketFileId(effect);
  if (!isMarketInstalled(effect)) return;
  if (activeEffectId.value === id) return;
  const applied = player.selectSpatialAudioEffect(id);
  if (!applied) return;
  toast.success(`已应用「${effect.name}」`);
};

const marketMeta = (effect: CommunityAudioEffect) => {
  const author = effect.author || effect.artistName || '';
  const count = effect.userCount ? `${effect.userCount} 人使用` : '';
  return [author, count].filter(Boolean).join(' · ');
};

// 市场只在切到该页签时才拉：只想调均衡器的人不该白等一次网络请求
watch(activeTab, (tab) => {
  if (tab === 'market' && !marketEffects.value.length && !marketLoading.value) {
    void loadMarket(1);
  }
});
</script>

<template>
  <Sheet
    :model-value="props.modelValue"
    title="音效"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <!-- 页签栏放 header 插槽：它在滚动区外面，市场列表再长页签也一直可见 -->
    <template #header>
      <nav class="tabs" role="tablist" aria-label="音效分类">
        <button
          v-for="tab in TABS"
          :key="tab.id"
          type="button"
          class="tab"
          role="tab"
          :class="{ 'is-active': activeTab === tab.id }"
          :aria-selected="activeTab === tab.id"
          @click="activeTab = tab.id"
        >
          {{ tab.label }}
          <span class="tab-underline" aria-hidden="true" />
        </button>
      </nav>
    </template>

    <!-- 均衡器 -->
    <section v-if="activeTab === 'eq'" class="pane" role="tabpanel">
      <header class="pane-head">
        <h3 class="pane-title">10 段均衡器</h3>
        <button type="button" class="pane-action" @click="resetEq">重置</button>
      </header>

      <!-- 预设：3 列网格，点一下直接应用；当前曲线命中哪个就高亮哪个 -->
      <div class="preset-grid">
        <button
          v-for="preset in EQ_PRESETS"
          :key="preset.id"
          type="button"
          class="preset-chip"
          :class="{ 'is-active': preset.id === activePresetId }"
          :aria-pressed="preset.id === activePresetId"
          @click="applyPreset(preset)"
        >
          {{ preset.label }}
        </button>
      </div>

      <div class="eq">
        <label v-for="(hz, index) in BANDS" :key="hz" class="eq-band">
          <span class="eq-value">{{ (gains[index] ?? 0) > 0 ? '+' : '' }}{{ (gains[index] ?? 0).toFixed(1) }}</span>
          <!--
            推子的"视觉占位"。竖排推子是把 input 旋转 90° 得到的，而**旋转不改变布局盒** ——
            直接把 110px 宽的 input 放进 flex 行，每个频段都会被撑到 110px
            （`flex: 1` 压不住：flex 项不会收缩到内容最小宽度以下），
            实测 10 档从 x=20 排到 x=1046，屏幕上只露得出 4 档。
            所以用这个 20×110 的占位元素承载布局，input 绝对定位在它里面旋转。
          -->
          <span class="eq-slider-slot">
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
          </span>
          <span class="eq-label">{{ bandLabel(hz) }}</span>
        </label>
      </div>

      <button type="button" class="apply" :disabled="!dirty" @click="applyEq">
        {{ dirty ? '应用均衡器' : '已应用' }}
      </button>
    </section>

    <!-- 我的音效 -->
    <section v-else-if="activeTab === 'mine'" class="pane" role="tabpanel">
      <header class="pane-head">
        <h3 class="pane-title">已安装的音效</h3>
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
        <span v-if="String(file.id) === activeEffectId" class="effect-badge is-on">使用中</span>
      </button>

      <p v-if="!usableEffects.length" class="pane-empty">
        还没有音效。去「音效市场」挑一个，或在「设置」里导入 WAV / IRS 文件。
      </p>
    </section>

    <!-- 音效市场 -->
    <section v-else class="pane" role="tabpanel">
      <header class="pane-head">
        <h3 class="pane-title">社区音效</h3>
        <span v-if="marketEffects.length" class="pane-count">已加载 {{ marketEffects.length }}</span>
      </header>

      <!-- 排序分页：推荐 / 最热 / 最新，切过去重拉第一页 -->
      <div class="sort-tabs" role="tablist" aria-label="排序方式">
        <button
          v-for="sort in SORTS"
          :key="sort.value"
          type="button"
          class="sort-tab"
          role="tab"
          :class="{ 'is-active': sort.value === marketSort }"
          :aria-selected="sort.value === marketSort"
          @click="changeMarketSort(sort.value)"
        >
          {{ sort.label }}
        </button>
      </div>

      <p v-if="marketLoading && !marketEffects.length" class="pane-empty">正在加载…</p>
      <p v-else-if="marketError && !marketEffects.length" class="pane-empty">
        {{ marketError }}
      </p>
      <p v-else-if="!marketEffects.length" class="pane-empty">
        {{ marketRawCount ? '没有可在安卓上使用的音效' : '市场暂时没有内容' }}
      </p>

      <!--
        行点击分两种情况：**已下载的**点行就是切换应用（和「音效」页签选一个一样）；
        **没下载的**行不接任何点击，只能按尾部那颗「下载」——
        否则误触就会开始下载，而下载完想再点开看看又会重复下载。
      -->
      <div
        v-for="effect in marketEffects"
        :key="effect.id"
        class="market-item"
        :class="{
          'is-active': effect.id === appliedMarketId,
          'is-selectable': isMarketInstalled(effect),
        }"
        @click="isMarketInstalled(effect) && selectMarketEffect(effect)"
      >
        <span class="effect-body">
          <span class="effect-name ellipsis">{{ effect.name }}</span>
          <span class="effect-meta ellipsis">{{ marketMeta(effect) }}</span>
        </span>
        <span v-if="effect.id === appliedMarketId" class="effect-badge is-on">使用中</span>
        <button
          type="button"
          class="market-action"
          :class="{ 'is-uninstall': isMarketInstalled(effect) }"
          :disabled="downloadingId !== 0"
          @click="isMarketInstalled(effect) ? uninstallMarketEffect(effect) : applyMarketEffect(effect)"
        >
          {{ downloadingId === effect.id ? '下载中…' : isMarketInstalled(effect) ? '卸载' : '下载' }}
        </button>
      </div>

      <button
        v-if="hasMoreMarket"
        type="button"
        class="load-more"
        :disabled="marketLoading"
        @click="loadMarket(marketPage + 1)"
      >
        {{ marketLoading ? '加载中…' : '加载更多' }}
      </button>
    </section>
  </Sheet>
</template>

<style scoped>
/* ── 页签栏（在 header 插槽里，不随内容滚动） ── */
.tabs {
  display: flex;
  gap: var(--sp-1);
  margin: 0 calc(var(--sp-2) * -1);
}

.tab {
  position: relative;
  flex: 1;
  min-height: 40px;
  padding: 0 var(--sp-1);
  font-size: var(--font-md);
  color: var(--text-tertiary);
  transition: color var(--duration-fast) var(--ease-standard);
}

.tab.is-active {
  color: var(--text-primary);
  font-weight: var(--weight-semibold);
}

/* 下划线比文字窄一点、贴中间：和主页子页签同一套视觉语言 */
.tab-underline {
  position: absolute;
  left: 50%;
  bottom: 4px;
  width: 20px;
  height: 2px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  transform: translateX(-50%) scaleX(0);
  transition: transform var(--duration-fast) var(--ease-standard);
}

.tab.is-active .tab-underline {
  transform: translateX(-50%) scaleX(1);
}

/* ── 面板 ── */
.pane-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.pane-title {
  margin: 0;
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--text-primary);
}

.pane-action {
  min-height: 30px;
  padding: 0 var(--sp-2);
  font-size: var(--font-sm);
  color: var(--accent);
}

.pane-count {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
  font-variant-numeric: tabular-nums;
}

.pane-empty {
  margin: var(--sp-2) 0 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

/* ── 预设均衡器 ── */
.preset-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}

.preset-chip {
  min-height: 40px;
  border-radius: var(--radius-md);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--fill-subtle);
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}

.preset-chip.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  font-weight: var(--weight-semibold);
}

/* ── 均衡器 ── */
.eq {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-1);
}

.eq-band {
  flex: 1;
  /* 没有这条的话频段不会被压到内容宽度以下（input 的 110px）—— 见模板里的注释 */
  min-width: 0;
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

/*
 * 竖排推子的视觉占位：宽 20px = 旋转后 input 的视觉宽，高 110px = 旋转后的视觉高。
 * 布局按这个盒子算，input 自己绝对定位进来，不参与 flex 尺寸计算。
 */
.eq-slider-slot {
  position: relative;
  display: block;
  width: 20px;
  height: 110px;
  touch-action: none;
}

/* WebView 不认 writing-mode 的 range，只能转 90 度；布局盒由外层 slot 兜着 */
.eq-slider {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 110px;
  height: 20px;
  margin: 0;
  /* 先把自己挪到中心再旋转，转完正好落在 slot 里 */
  transform: translate(-50%, -50%) rotate(-90deg);
  -webkit-appearance: none;
  appearance: none;
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

/* ── 排序分页（视觉与设置里的分段控件同一套：accent + accent-soft） ── */
.sort-tabs {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.sort-tab {
  flex: 1;
  min-height: 36px;
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--fill-subtle);
  border: 1px solid transparent;
  transition:
    background var(--duration-fast) var(--ease-standard),
    color var(--duration-fast) var(--ease-standard);
}

.sort-tab.is-active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
  font-weight: var(--weight-semibold);
}

/* ── 音效行（两个页签共用） ── */
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

.effect-badge {
  flex: 0 0 auto;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-pill);
  font-size: var(--font-xs);
  color: var(--accent);
  background: var(--accent-soft);
}

.effect-badge.is-on {
  color: var(--accent);
}

.effect-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.effect-meta {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

/*
 * 市场行是 div（不是 button）：整行不接点击，操作只走尾部那颗按钮。
 * 布局与上面的 .effect-item 保持一致，只是去掉了按钮的交互样式。
 */
.market-item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  min-height: 52px;
  padding: 0 var(--sp-2);
  border-radius: var(--radius-sm);
}

.market-item.is-active .effect-name {
  color: var(--accent);
  font-weight: var(--weight-semibold);
}

/* 已下载的行可点（切换应用）：给一点按压反馈，让"能点"这件事看得出来 */
.market-item.is-selectable:active {
  background: var(--fill-subtle);
}

/* 下载 / 卸载：显式按钮，不靠整行触发 */
.market-action {
  flex: 0 0 auto;
  min-width: 56px;
  min-height: 32px;
  padding: 0 var(--sp-3);
  border-radius: var(--radius-pill);
  font-size: var(--font-sm);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
  transition: opacity var(--duration-fast) var(--ease-standard);
}

.market-action:active:not(:disabled) {
  opacity: 0.75;
}

/* 卸载用中性色：跟"下载"的主操作区分开，也避免误点 */
.market-action.is-uninstall {
  color: var(--text-secondary);
  background: var(--fill-muted);
}

.market-action:disabled {
  opacity: 0.5;
}

.load-more {
  width: 100%;
  min-height: 44px;
  margin-top: var(--sp-2);
  border-radius: var(--radius-md);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--fill-subtle);
}

.load-more:disabled {
  opacity: 0.5;
}
</style>
