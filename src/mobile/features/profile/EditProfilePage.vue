<script setup lang="ts">
/**
 * 编辑个人资料。
 *
 * ## 为什么是独立页面而不是底部面板
 *
 * 字段有 7 个（头像/昵称/签名/性别/生日/省/市），底部面板里塞这么多输入框，
 * 键盘一弹起来就被顶掉大半，还得自己处理滚动。独立页天然有整屏高度，
 * 也能正常用系统返回键退出。
 *
 * ## 表单是 `original` 的一份副本
 *
 * `useEditableProfile()` 跟着 store 走，而保存后会 `fetchUserInfo()` 刷新它。
 * 如果直接把输入框 v-model 绑到它上面，用户正在输入时后台一刷新就会被冲掉。
 * 所以复制一份给表单，只在**首次拿到非空资料**时同步一次（见下面的 watch）。
 *
 * ## 头像先本地预览，保存时才上传
 *
 * 选完图立刻上传会有两个问题：用户可能只是想换个图又反悔；上传还可能要过审核。
 * 所以只做 objectURL 预览，真正的上传放在保存里，和文本字段一起提交。
 */
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import PageHeader from '@mobile/components/PageHeader.vue';
import ActionSheet from '@mobile/components/ActionSheet.vue';
import { iconCamera, iconUser } from '@mobile/icons';
import {
  PROVINCES,
  SEX_OPTIONS,
  saveProfile,
  useEditableProfile,
} from '@mobile/adapters/profileEdit';
import type { EditableProfile } from '@mobile/adapters/profileEdit';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';

defineOptions({ name: 'EditProfilePage' });

const router = useRouter();
const toast = useToastStore();

const original = useEditableProfile();

const blank: EditableProfile = {
  nickname: '',
  signature: '',
  sex: 2,
  birthday: '',
  province: '',
  city: '',
  avatarUrl: '',
};

const form = ref<EditableProfile>({ ...blank });
/** 是否已经用真实资料填过一次表单 */
const seeded = ref(false);
/** 新选的头像文件（未选择时为 null，表示不动原头像） */
const avatarFile = ref<File | null>(null);
const avatarPreview = ref('');
const saving = ref(false);
const provinceOpen = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/**
 * 只在**首次**拿到非空资料时填表。
 *
 * 进页面时 `user.info` 可能还在异步拉取，首帧是空的 —— 不能就这么把空值写进表单，
 * 否则用户看到的是空昵称。拿到真数据后填一次，之后不再覆盖（否则会冲掉正在输入的内容）。
 */
watch(
  original,
  (value) => {
    if (seeded.value) return;
    if (!value.nickname && !value.avatarUrl) return;
    form.value = { ...value };
    seeded.value = true;
  },
  { immediate: true },
);

const dirty = computed(() => {
  if (avatarFile.value) return true;
  const next = form.value;
  const base = original.value;
  return (
    next.nickname.trim() !== base.nickname.trim() ||
    next.signature.trim() !== base.signature.trim() ||
    next.sex !== base.sex ||
    next.birthday !== base.birthday ||
    next.province !== base.province ||
    next.city.trim() !== base.city.trim()
  );
});

const shownAvatar = computed(() => avatarPreview.value || form.value.avatarUrl);

const provinceItems = computed(() => [
  { key: '', label: '（不设置）' },
  ...PROVINCES.map((name) => ({ key: name, label: name })),
]);

const pickAvatar = () => fileInput.value?.click();

const onAvatarChange = (event: Event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0] ?? null;
  // 必须清空：否则连选同一张图时第二次不会触发 change
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast.warning('请选择图片文件');
    return;
  }
  if (avatarPreview.value) URL.revokeObjectURL(avatarPreview.value);
  avatarFile.value = file;
  avatarPreview.value = URL.createObjectURL(file);
};

const onProvinceSelect = (key: string) => {
  form.value.province = key;
};

const save = async () => {
  if (saving.value) return;

  const nickname = form.value.nickname.trim();
  if (!nickname) {
    toast.warning('昵称不能为空');
    return;
  }

  saving.value = true;
  try {
    const result = await saveProfile(form.value, original.value, avatarFile.value);
    if (result.changed === 0) {
      toast.info('没有需要保存的改动');
      return;
    }

    // 头像走审核队列，是**成功**而不是失败，所以按成功提示、只是措辞不同
    if (result.reviewPending) toast.info('资料已保存，头像正在审核中');
    else toast.info('资料已保存');

    avatarFile.value = null;
    router.back();
  } catch (error) {
    // 不吞异常：失败原因（敏感词、权限、图片格式）对用户有意义，
    // 吞掉就变成"点了没反应"
    logger.warn('EditProfile', 'Save failed', error);
    toast.warning(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
};
</script>

<template>
  <div class="edit-page">
    <PageHeader title="编辑资料" />

    <div class="edit-body scroll-y">
      <!-- 头像 -->
      <section class="card avatar-card">
        <button type="button" class="avatar-button" aria-label="更换头像" @click="pickAvatar">
          <img v-if="shownAvatar" :src="shownAvatar" alt="" />
          <Icon v-else :icon="iconUser" width="30" height="30" />
          <span class="avatar-badge"><Icon :icon="iconCamera" width="14" height="14" /></span>
        </button>
        <p class="avatar-hint">
          {{ avatarFile ? '已选择新头像，保存后生效' : '点击更换头像' }}
        </p>
      </section>

      <!-- 基本资料 -->
      <section class="card">
        <label class="field">
          <span class="field-label">昵称</span>
          <input
            v-model="form.nickname"
            class="field-input"
            type="text"
            maxlength="16"
            placeholder="取一个昵称"
            enterkeyhint="done"
          />
        </label>

        <label class="field is-stacked">
          <span class="field-label">个性签名</span>
          <textarea
            v-model="form.signature"
            class="field-input field-textarea"
            maxlength="60"
            rows="2"
            placeholder="说点什么"
          ></textarea>
        </label>

        <div class="field is-stacked">
          <span class="field-label">性别</span>
          <div class="segmented" role="group" aria-label="性别">
            <button
              v-for="option in SEX_OPTIONS"
              :key="option.value"
              type="button"
              class="segment"
              :class="{ 'is-active': form.sex === option.value }"
              @click="form.sex = option.value"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <label class="field">
          <span class="field-label">生日</span>
          <input v-model="form.birthday" class="field-input date-input" type="date" />
        </label>

        <div class="field is-stacked">
          <span class="field-label">所在地区</span>
          <div class="region-row">
            <button type="button" class="field-input picker" @click="provinceOpen = true">
              {{ form.province || '选择省份' }}
            </button>
            <input
              v-model="form.city"
              class="field-input city-input"
              type="text"
              maxlength="20"
              placeholder="城市"
            />
          </div>
        </div>
      </section>

      <button
        type="button"
        class="save-button"
        :disabled="saving || !dirty"
        @click="save"
      >
        {{ saving ? '保存中…' : '保存' }}
      </button>

      <p class="tail-note">
        头像提交后需要经过审核才会生效；其他资料保存后立即更新。
      </p>
    </div>

    <!-- 隐藏的文件选择器：WebView 会调起系统相册 -->
    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      class="file-input"
      @change="onAvatarChange"
    />

    <ActionSheet
      v-model="provinceOpen"
      title="选择省份"
      :items="provinceItems"
      @select="onProvinceSelect"
    />
  </div>
</template>

<style scoped>
.edit-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.edit-body {
  flex: 1;
  min-height: 0;
  padding: 0 var(--sp-4) var(--sp-6);
}

.card {
  margin-bottom: var(--sp-3);
  padding: var(--sp-4);
  border-radius: var(--radius-lg);
  background: var(--bg-raised);
}

/* ── 头像 ── */
.avatar-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-5) var(--sp-4);
}

.avatar-button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 84px;
  height: 84px;
  border-radius: 50%;
  /*
   * 不要 overflow: hidden —— 相机角标压在圆的右下边界上，裁掉后只剩半个图标（实测）。
   * 圆形裁剪改由 img 自己负责。
   */
  color: var(--text-tertiary);
  background: var(--bg-input);
}

.avatar-button img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.avatar-button:active {
  opacity: 0.8;
}

/* 相机角标压在圆形右下，用描边色勾一圈边以免和头像糊在一起 */
.avatar-badge {
  position: absolute;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  color: #fff;
  background: var(--accent);
  border: 2px solid var(--bg-raised);
}

.avatar-hint {
  margin: 0;
  font-size: var(--font-xs);
  color: var(--text-tertiary);
}

/* ── 表单 ── */
.field {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-height: 48px;
}

.field + .field {
  border-top: 1px solid var(--divider);
}

.field.is-stacked {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
  padding: var(--sp-3) 0;
}

.field-label {
  flex: 0 0 72px;
  font-size: var(--font-sm);
  color: var(--text-secondary);
}

.field.is-stacked .field-label {
  flex: none;
}

.field-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 var(--sp-3);
  border: 0;
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  font-family: inherit;
  color: var(--text-primary);
  background: var(--bg-input);
  outline: none;
}

.field-textarea {
  height: auto;
  min-height: 62px;
  padding: var(--sp-2) var(--sp-3);
  line-height: 1.5;
  resize: none;
}

/* 原生日期控件：不加 color-scheme 的话选择器会是一块亮白，和深色主题完全割裂 */
.date-input {
  color-scheme: dark;
}

/* ── 性别分段 ── */
.segmented {
  display: flex;
  gap: var(--sp-2);
}

.segment {
  flex: 1;
  height: 38px;
  border-radius: var(--radius-sm);
  font-size: var(--font-sm);
  color: var(--text-secondary);
  background: var(--bg-input);
}

.segment.is-active {
  color: var(--accent);
  font-weight: var(--weight-semibold);
  box-shadow: inset 0 0 0 1px var(--accent);
}

/* ── 地区 ── */
.region-row {
  display: flex;
  gap: var(--sp-2);
}

.picker {
  flex: 0 0 108px;
  text-align: left;
  color: var(--text-primary);
}

.city-input {
  flex: 1;
}

/* ── 保存 ── */
.save-button {
  width: 100%;
  min-height: 46px;
  border-radius: var(--radius-pill);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.save-button:active:not(:disabled) {
  opacity: 0.85;
}

.save-button:disabled {
  color: var(--text-tertiary);
  background: var(--bg-input);
}

.tail-note {
  margin: var(--sp-3) 0 0;
  font-size: var(--font-xs);
  line-height: 1.6;
  text-align: center;
  color: var(--text-tertiary);
}

.file-input {
  display: none;
}
</style>
