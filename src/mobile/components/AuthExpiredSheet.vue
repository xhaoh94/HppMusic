<script setup lang="ts">
/**
 * 登录已过期提示。
 *
 * 内核的 `utils/request.ts` 在检测到会话失效时会调
 * `authStore.showSessionExpiredDialog()` —— 它**不直接 logout**，只置一个标志，
 * 由界面弹窗让用户确认。桌面端有这个弹窗，移动端一直缺着，
 * 后果是：token 失效后接口静默返回空数据，用户看到的是
 * 「收藏还是空的」「搜索没有结果」，而不是「你掉线了」。
 *
 * 这里补上移动端的对应实现。确认后走 `user.logout()` 并切到登录页 ——
 * 不清 token 的话每个接口都会继续拿着废 token 打一遍，白费流量且状态更乱。
 */
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Sheet from '@mobile/components/Sheet.vue';
import { useAuthStore } from '@/stores/auth';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';

const router = useRouter();
const auth = useAuthStore();
const user = useUserStore();
const toast = useToastStore();

const open = computed({
  get: () => auth.sessionExpiredDialogOpen,
  set: (value: boolean) => {
    if (!value) auth.hideSessionExpiredDialog();
  },
});

const title = computed(() => auth.sessionExpiredPayload?.title || '登录已过期');
const description = computed(
  () =>
    auth.sessionExpiredPayload?.description ||
    '您的登录信息已失效，为了您的账号安全，请重新登录。',
);

const relogin = () => {
  auth.hideSessionExpiredDialog();
  user.logout();
  toast.info('请重新登录');
  void router.replace({ name: 'login' });
};

const later = () => {
  auth.hideSessionExpiredDialog();
};
</script>

<template>
  <Sheet v-model="open" :title="title" :dismiss-on-mask="false">
    <p class="auth-text">{{ description }}</p>
    <template #footer>
      <div class="auth-actions">
        <button type="button" class="ghost-button" @click="later">稍后</button>
        <button type="button" class="primary-button" @click="relogin">重新登录</button>
      </div>
    </template>
  </Sheet>
</template>

<style scoped>
.auth-text {
  margin: 0;
  font-size: var(--font-md);
  line-height: 1.6;
  color: var(--text-secondary);
}

.auth-actions {
  display: flex;
  gap: var(--sp-3);
}

.ghost-button,
.primary-button {
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

.primary-button {
  color: var(--accent-on);
  background: var(--accent);
}

.primary-button:active {
  background: var(--accent-pressed);
}
</style>
