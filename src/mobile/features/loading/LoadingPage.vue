<script setup lang="ts">
/**
 * 启动页：设备注册 → 播放引擎自检 → 进主界面。
 *
 * 为什么必须放在这里而不是主界面里异步做：设备注册（dfid）是**登录与全部
 * 在线接口的前置**，且它自己要走一次非对称加密请求。放进主界面会让首页先渲染
 * 出一屏「加载失败」，再在几百毫秒后自己好起来 —— 用户会以为应用坏了。
 *
 * 三态齐全（进行中 / 可重试失败 / 可强行进入），是刻意的：
 * 旧方案里设备注册失败直接落错误页、没有出口，网络抖一下就得杀进程重来。
 */
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconRefresh, iconSpinner, iconWarning } from '@mobile/icons';
import { ensureDevice } from '@/utils/device';
import { useDeviceStore } from '@/stores/device';
import { useToastStore } from '@/stores/toast';
import logger from '@/utils/logger';

const router = useRouter();
const toast = useToastStore();
const deviceStore = useDeviceStore();

type Phase = 'running' | 'failed';

const phase = ref<Phase>('running');
const message = ref('正在注册设备信息…');
/** 失败原因（展示给用户，而不是只写日志） */
const failureReason = ref('');
/** 失败是否仍然可以进主界面（设备注册失败时，在线功能会受影响，但浏览历史/我的可用） */
const canContinue = ref(false);
const busy = ref(false);

const gotoMain = () => {
  void router.replace({ name: 'home' });
};

const step = async <T,>(label: string, run: () => Promise<T>): Promise<T> => {
  message.value = label;
  return await run();
};

const bootstrap = async () => {
  busy.value = true;
  phase.value = 'running';
  failureReason.value = '';

  try {
    /**
     * 桥自检。`apiServer.status()` 在移动端是桥自己实现的桩（永远 ready），
     * 调它不是为了拿状态，而是确认 `window.electron` 真的挂上了 ——
     * 桥挂失败的典型症状是后面每一步都报 "undefined is not a function"，
     * 在这里点出来能省掉一轮排查。
     */
    await step('正在初始化网络服务…', async () => {
      const status = await window.electron?.apiServer?.status();
      if (!status) throw new Error('API 桥未就绪');
      return status;
    });

    await step('正在注册设备信息…', async () => {
      /**
       * 带一次自动重试。
       *
       * 实测：首次请求 `/register/dev` 偶发返回 `{status:1, error_code:0, data:[]}`
       * （data 是空数组而不是 `{dfid}`），紧接着重试就正常返回 dfid 了。
       * 内核的 `ensureDevice` 把空 data 当成失败且不会重试，于是用户看到的是
       * 「设备注册失败」的错误页 —— 其实再等一下就好。
       * 所以在 UI 层补一次重试，而不是去改内核（内核由 sync 全量覆盖）。
       */
      const attempt = async () => {
        await ensureDevice();
        return Boolean(deviceStore.info?.dfid);
      };

      if (await attempt()) return;
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      if (!(await attempt())) throw new Error('设备注册失败，未能取得设备标识');
    });

    await step('正在检查播放引擎…', async () => {
      const available = await window.electron?.player?.available?.();
      if (!available) throw new Error('播放引擎不可用');
      return available;
    });

    message.value = '准备就绪';
    gotoMain();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    logger.error('Startup', 'Bootstrap failed:', error);
    failureReason.value = reason;
    // 设备注册（拿到 dfid）失败时在线功能会大面积不可用，仍然放行；
    // 播放引擎不可用同样放行（可以看歌单/用搜索，只是放不出声）。
    canContinue.value = true;
    phase.value = 'failed';
  } finally {
    busy.value = false;
  }
};

const retry = () => {
  if (busy.value) return;
  void bootstrap();
};

const continueAnyway = () => {
  if (!canContinue.value) return;
  toast.warning('以受限模式进入：部分在线功能可能不可用');
  gotoMain();
};

onMounted(() => {
  void bootstrap();
});
</script>

<template>
  <div class="loading-page">
    <div class="loading-body">
      <div class="brand">
        <span class="brand-dot" aria-hidden="true" />
        <h1 class="brand-name">HppMusic</h1>
      </div>

      <template v-if="phase === 'running'">
        <Icon :icon="iconSpinner" width="26" height="26" class="spinner" />
        <p class="status">{{ message }}</p>
      </template>

      <template v-else>
        <Icon :icon="iconWarning" width="28" height="28" class="failed-icon" />
        <p class="status">启动未完全就绪</p>
        <p class="detail">{{ failureReason }}</p>
        <div class="actions">
          <button type="button" class="primary-button" :disabled="busy" @click="retry">
            <Icon :icon="iconRefresh" width="16" height="16" />
            重试
          </button>
          <button v-if="canContinue" type="button" class="ghost-button" @click="continueAnyway">
            仍然进入
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.loading-page {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: var(--safe-top) var(--sp-6) var(--safe-bottom);
  background: var(--bg-base);
}

.loading-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  text-align: center;
}

.brand {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-6);
}

.brand-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
}

.brand-name {
  margin: 0;
  font-size: var(--font-3xl);
  font-weight: var(--weight-bold);
  letter-spacing: 0.02em;
}

.spinner {
  color: var(--accent);
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.failed-icon {
  color: var(--warning);
}

.status {
  margin: 0;
  font-size: var(--font-lg);
  font-weight: var(--weight-semibold);
}

.detail {
  margin: 0;
  max-width: 300px;
  font-size: var(--font-sm);
  color: var(--text-secondary);
  word-break: break-word;
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
}

.primary-button {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  min-height: 44px;
  padding: 0 var(--sp-5);
  border-radius: var(--radius-pill);
  font-size: var(--font-md);
  font-weight: var(--weight-semibold);
  color: var(--accent-on);
  background: var(--accent);
}

.primary-button:disabled {
  opacity: 0.6;
}

.primary-button:active:not(:disabled) {
  background: var(--accent-pressed);
}

.ghost-button {
  min-height: 44px;
  padding: 0 var(--sp-4);
  border-radius: var(--radius-pill);
  font-size: var(--font-md);
  color: var(--text-secondary);
}

.ghost-button:active {
  background: var(--fill-muted);
}
</style>
