import { onScopeDispose, ref, watch, type Ref } from 'vue';

/** 实时联想只辅助输入；网络失败不能阻断手动搜索。 */
export const useSearchSuggestions = (
  keyword: Ref<string>,
  load: (query: string) => Promise<string[]>,
) => {
  const suggestions = ref<string[]>([]);
  const isComposing = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let disposed = false;
  let compositionEndedAt = -Infinity;

  // 底层 IPC 接口不支持 AbortSignal，用代次令已发送的请求失效。
  const cancel = () => {
    generation += 1;
    clearTimeout(timer);
    timer = undefined;
    suggestions.value = [];
  };

  const schedule = () => {
    cancel();
    const query = keyword.value.trim();
    if (disposed || isComposing.value || !query) return;
    const currentGeneration = generation;
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        const result = await load(query);
        if (currentGeneration === generation) suggestions.value = result;
      } catch {
        // 包括旧请求的错误都在这里消费，不弹窗、不影响提交。
        if (currentGeneration === generation) suggestions.value = [];
      }
    }, 250);
  };

  // 同步失效，避免旧响应在下一次 Vue 更新前回填；程序化提交后 cancel 也不会再排队。
  watch(keyword, schedule, { flush: 'sync' });

  const startComposition = () => {
    isComposing.value = true;
    cancel();
  };

  const endComposition = (value: string) => {
    keyword.value = value;
    isComposing.value = false;
    compositionEndedAt = Date.now();
    schedule();
  };

  const canSubmitOnEnter = (event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>) =>
    !isComposing.value &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    // 部分 WebView 会先派发 compositionend，再派发确认候选词的 keydown。
    Date.now() - compositionEndedAt >= 50;

  onScopeDispose(() => {
    disposed = true;
    cancel();
  });

  return { suggestions, cancel, startComposition, endComposition, canSubmitOnEnter };
};
