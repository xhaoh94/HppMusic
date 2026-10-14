<script setup lang="ts">
/**
 * 「添加到歌单」面板。
 *
 * ## 为什么支持多选
 *
 * 收藏一首歌进多个歌单（比如「通勤」「运动」）是常见动作，逐个进两次面板很烦。
 * 所以这里是勾选式：`确认（N）`，一次提交给多个歌单。上游桌面端也是这个交互。
 *
 * ## 数据全部来自内核，不自己拼接口
 *
 * - 歌单列表：`playlistStore.userPlaylists`（`fetchUserPlaylists()` 从服务端拉）
 * - 加歌：`playlistStore.addToPlaylist(listId, song)` → `'added' | 'exists' | 'failed'`
 * - 新建：`playlistStore.createPlaylistAndReturnId(name, false, userId)`
 *
 * ## ⚠️ 提交必须用数字 `listid`，不能用 `globalCollectionId`
 *
 * `addToPlaylist` 最终调 `/playlist/tracks/add?listid=`，**服务端只认数字 listid**。
 * 用于展示或路由的那种 `collection_3_{uid}_{listid}_0`（详情页要的）传进去会返回
 * 非 1 状态 → `'failed'`，面板上表现为“添加失败”但看不出原因。
 * 收藏功能走的是 `ensureLikedPlaylistReady()` 回来的数字 `listId`，所以一直正常 ——
 * 这里照它取 `listid ?? id` 作为身份键。
 *
 * 沿用 `MyPlaylistsPage` 的做法：`getCreatedPlaylists(userId)` 把“我创建的”排在前面，
 * 其余是收藏来的歌单 —— 混在一起用户分不清哪个是自己建的。
 */
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import Sheet from '@mobile/components/Sheet.vue';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';
import type { PlaylistMeta } from '@/models/playlist';
import type { Song } from '@/models/song';
import { iconAdd, iconPlaylistAdd, iconSuccess } from '@mobile/icons';

const props = defineProps<{
  modelValue: boolean;
  /** 要加入的歌；为空时面板只展示提示（正常情况下不会打开） */
  song: Song | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const playlist = usePlaylistStore();
const user = useUserStore();
const toast = useToastStore();

const loading = ref(false);
const submitting = ref(false);
const loadError = ref('');
/** 勾选中的歌单 id（内核的 addToPlaylist 吃 string|number，统一用 string 比较） */
const selected = ref<Set<string>>(new Set());

/* ── 新建歌单 ── */
const creating = ref(false);
const newName = ref('');

/**
 * 歌单的身份键：**数字 listid**。
 *
 * 直接用 `listid ?? id` 而不优先 `globalCollectionId`：后者是给详情页路由用的
 * 组合串，传给加歌接口服务端不认（见文件头）。
 */
const numericIdOf = (item: PlaylistMeta) => String(item.listid ?? item.id ?? '');

/**
 * 一个歌单可能被若干个值引用（数字 id / listid / collection 串…）。
 * `createPlaylistAndReturnId` 回来的是裸数字，要在新列表里找它就得逐个比。
 */
const identityValues = (item: PlaylistMeta) =>
  [item.id, item.listid, item.globalCollectionId, item.listCreateGid, item.listCreateListid]
    .filter((value) => value !== undefined && value !== null && String(value) !== '')
    .map((value) => String(value));

const all = computed<PlaylistMeta[]>(() => playlist.userPlaylists ?? []);

const created = computed(() => {
  const userId = user.info?.userid;
  if (!userId) return [];
  try {
    return playlist.getCreatedPlaylists(userId);
  } catch {
    return [];
  }
});

/** 我创建的在前，收藏的在后 */
const options = computed(() => {
  const createdIds = new Set(created.value.map((item) => numericIdOf(item)));
  const others = all.value.filter((item) => !createdIds.has(numericIdOf(item)));
  const ordered = [...created.value, ...others];
  // 同一首 id 可能在两类里都出现，去重后再渲染（key 重复会让勾选状态错乱）
  const seen = new Set<string>();
  return ordered.filter((item) => {
    const id = numericIdOf(item);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
});

const countOf = (item: PlaylistMeta) => item.count ?? item.songcount ?? 0;

const toggle = (item: PlaylistMeta) => {
  const id = numericIdOf(item);
  if (!id) return;
  const next = new Set(selected.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selected.value = next;
};

const load = async () => {
  loadError.value = '';
  loading.value = true;
  try {
    await playlist.fetchUserPlaylists();
  } catch (error) {
    logger.warn('AddToPlaylist', 'Load user playlists failed', error);
    loadError.value = error instanceof Error ? error.message : '歌单加载失败';
  } finally {
    loading.value = false;
  }
};

// 每次打开都重置勾选并把「新建」收起来：上一次的输入不该残留
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    selected.value = new Set();
    creating.value = false;
    newName.value = '';
    void load();
  },
  { immediate: true },
);

const createAndSelect = async () => {
  const name = newName.value.trim();
  if (!name) return;
  const userId = user.info?.userid;
  if (!userId) {
    toast.warning('请先登录后再新建歌单');
    return;
  }
  creating.value = true;
  try {
    const newId = await playlist.createPlaylistAndReturnId(name, false, userId);
    if (newId == null) throw new Error('新建歌单失败');
    await playlist.fetchUserPlaylists();
    // 返回的是裸数字 listid，而勾选状态按 numericIdOf() 存。
    // 先在新列表里把它找出来再取键，否则新建完看不到刚勾上的那个歌单。
    const createdItem =
      options.value.find((item) => identityValues(item).includes(String(newId))) ??
      options.value.find((item) => item.name === name);
    if (createdItem) {
      const next = new Set(selected.value);
      next.add(numericIdOf(createdItem));
      selected.value = next;
    }
    newName.value = '';
    creating.value = false;
    toast.success(`已新建歌单「${name}」`);
  } catch (error) {
    logger.warn('AddToPlaylist', 'Create playlist failed', error);
    toast.danger(error instanceof Error ? error.message : '新建歌单失败');
  } finally {
    creating.value = false;
  }
};

const submit = async () => {
  const song = props.song;
  if (!song) return;
  // selected 里已经是数字 listid（numericIdOf），可以直接交给接口
  const targets = [...selected.value];
  if (!targets.length) return;

  submitting.value = true;
  let ok = 0;
  let failed = 0;
  for (const listId of targets) {
    try {
      const result = await playlist.addToPlaylist(listId, song);
      // 'exists' 也算成功：歌本来就在里面，对用户来说结果一样
      if (result === 'failed') failed += 1;
      else ok += 1;
    } catch (error) {
      logger.warn('AddToPlaylist', `Add to ${listId} failed`, error);
      failed += 1;
    }
  }
  submitting.value = false;

  if (failed && !ok) {
    toast.danger('添加失败，请稍后重试');
    return;
  }
  const tip = `已添加到 ${ok} 个歌单${failed ? `，${failed} 个失败` : ''}`;
  if (failed) toast.warning(tip);
  else toast.success(tip);
  emit('update:modelValue', false);
};
</script>

<template>
  <Sheet
    :model-value="props.modelValue"
    title="添加到歌单"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <p v-if="props.song" class="subject ellipsis">{{ props.song.title || props.song.name }}</p>

    <!-- 新建歌单：放在最上面，找不到合适的歌单时不用先翻到底 -->
    <div class="create-row">
      <input
        v-model="newName"
        class="create-input"
        type="text"
        placeholder="新建歌单名称"
        enterkeyhint="done"
        @keyup.enter="createAndSelect"
      />
      <button
        type="button"
        class="create-button"
        :disabled="creating || !newName.trim()"
        @click="createAndSelect"
      >
        <Icon :icon="iconAdd" width="18" height="18" />
        新建
      </button>
    </div>

    <p v-if="loadError" class="status">{{ loadError }}</p>
    <p v-else-if="loading && !options.length" class="status">正在加载歌单…</p>
    <p v-else-if="!options.length" class="status">还没有歌单，先在上面新建一个吧</p>

    <button
      v-for="item in options"
      :key="numericIdOf(item)"
      type="button"
      class="option"
      :class="{ 'is-selected': selected.has(numericIdOf(item)) }"
      @click="toggle(item)"
    >
      <span class="option-cover">
        <img v-if="item.pic || item.imgurl" :src="item.pic || item.imgurl" alt="" />
        <Icon v-else :icon="iconPlaylistAdd" width="20" height="20" />
      </span>
      <span class="option-meta">
        <span class="option-name ellipsis">{{ item.name || '未命名歌单' }}</span>
        <span class="option-count">{{ countOf(item) }} 首</span>
      </span>
      <span class="option-check" aria-hidden="true">
        <Icon v-if="selected.has(numericIdOf(item))" :icon="iconSuccess" width="18" height="18" />
      </span>
    </button>

    <template #footer>
      <button
        type="button"
        class="submit"
        :disabled="submitting || !selected.size"
        @click="submit"
      >
        {{ submitting ? '正在添加…' : selected.size ? `添加到 ${selected.size} 个歌单` : '请选择歌单' }}
      </button>
    </template>
  </Sheet>
</template>

<style scoped>
.subject {
  margin: 0 0 var(--sp-3);
  font-size: var(--font-sm);
  color: var(--text-tertiary);
}

.create-row {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}

.create-input {
  flex: 1;
  min-width: 0;
  min-height: 42px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--divider-strong);
  border-radius: var(--radius-md);
  background: var(--fill-subtle);
  font-size: var(--font-md);
  color: var(--text-primary);
}

.create-input::placeholder {
  color: var(--text-tertiary);
}

.create-button {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 42px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-md);
  font-size: var(--font-sm);
  color: var(--accent);
  background: var(--accent-soft);
}

.create-button:disabled {
  opacity: 0.45;
}

.status {
  margin: var(--sp-4) 0;
  text-align: center;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.option {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  width: 100%;
  min-height: 60px;
  padding: var(--sp-2) var(--sp-1);
  text-align: left;
  border-radius: var(--radius-sm);
}

.option:active {
  background: var(--fill-subtle);
}

.option-cover {
  flex: 0 0 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--fill-muted);
  color: var(--text-tertiary);
}

.option-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.option-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.option-name {
  font-size: var(--font-md);
  color: var(--text-primary);
}

.option-count {
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

.option-check {
  flex: 0 0 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1.5px solid var(--divider-strong);
  border-radius: 50%;
  color: var(--accent-on);
}

.option.is-selected .option-check {
  border-color: var(--accent);
  background: var(--accent);
}

.submit {
  width: 100%;
  min-height: 46px;
  border-radius: var(--radius-md);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.submit:disabled {
  opacity: 0.45;
}
</style>
