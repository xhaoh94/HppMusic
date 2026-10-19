import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, type EffectScope } from 'vue';
import { getSearchSuggest } from '@/api/search';
import { getSearchSuggestions, parseSearchSuggestions } from '../src/mobile/adapters/search';
import { useSearchSuggestions } from '../src/mobile/composables/useSearchSuggestions';

vi.mock('@/api/search', () => ({
  search: vi.fn(),
  getSearchHot: vi.fn(),
  getSearchSuggest: vi.fn(),
}));

// 摘自 server/module/search_suggest.js 对「周杰伦」的匿名实测响应。
// 这里只保留解析相关字段，避免热度、排名变化影响测试。
const response = {
  status: 1,
  error_code: 0,
  ErrorCode: 0,
  data: [
    {
      LableName: '',
      RecordCount: 3,
      RecordDatas: [
        { HintInfo: '周杰伦', IsKlist: 1 },
        { HintInfo: '周杰伦 告白气球', IsKlist: 1 },
        { HintInfo: '周杰伦 稻香', IsKlist: 1 },
      ],
    },
    { LableName: 'MV', RecordDatas: [{ HintInfo: '周杰伦 - 晴天' }] },
    { LableName: '专辑', RecordDatas: [{ HintInfo: '周杰伦 - 七里香' }] },
  ],
  SingerShortcut: { id: 0, name: '' },
  Shortcuts: null,
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const scopes: EffectScope[] = [];
const setup = (load = vi.fn<(query: string) => Promise<string[]>>().mockResolvedValue([]), initial = '') => {
  const scope = effectScope();
  scopes.push(scope);
  const keyword = ref(initial);
  const state = scope.run(() => useSearchSuggestions(keyword, load))!;
  return { ...state, keyword, load, scope };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  scopes.splice(0).forEach((scope) => scope.stop());
  vi.useRealTimers();
});

describe('搜索建议响应解析', () => {
  it('解析实测的 data[].RecordDatas[].HintInfo，并保留上游顺序', () => {
    expect(parseSearchSuggestions(response)).toEqual([
      '周杰伦', '周杰伦 告白气球', '周杰伦 稻香', '周杰伦 - 晴天', '周杰伦 - 七里香',
    ]);
  });

  it('去除空白、跨分组去重，忽略非字符串和畸形条目', () => {
    expect(parseSearchSuggestions({
      data: [
        null,
        { RecordDatas: '错误类型' },
        { RecordDatas: [null, {}, { HintInfo: 123 }, { HintInfo: {} }, { HintInfo: '  ' }] },
        { RecordDatas: [{ HintInfo: ' 周杰伦 ' }, { HintInfo: '稻香' }] },
        { RecordDatas: [{ HintInfo: '周杰伦' }, { HintInfo: ' 稻香 ' }, { HintInfo: '晴天' }] },
      ],
    })).toEqual(['周杰伦', '稻香', '晴天']);
  });

  it('最多返回十条去重后的关键词', () => {
    const hints = Array.from({ length: 20 }, (_, index) => ({ HintInfo: `歌曲${index}` }));
    expect(parseSearchSuggestions({
      data: [{ RecordDatas: [hints[0], ...hints] }],
    })).toEqual(hints.slice(0, 10).map((item) => item.HintInfo));
  });

  it.each([null, undefined, [], {}, { data: null }, { data: {} }, { data: [] }, { ...response, status: 0 }])(
    '空响应或失败响应安全返回空列表：%j',
    (payload) => expect(parseSearchSuggestions(payload)).toEqual([]),
  );

  it('适配层复用 getSearchSuggest，裁剪空白且不请求空词', async () => {
    vi.mocked(getSearchSuggest).mockResolvedValue(response);
    expect(await getSearchSuggestions(' 周杰伦 ')).toEqual(parseSearchSuggestions(response));
    expect(getSearchSuggest).toHaveBeenCalledExactlyOnceWith('周杰伦');
    expect(await getSearchSuggestions('   ')).toEqual([]);
    expect(getSearchSuggest).toHaveBeenCalledTimes(1);
  });
});

describe('搜索建议防抖与请求失效', () => {
  it('路由初始关键词不自动请求，连续输入只在最后一次输入 250ms 后请求', async () => {
    const state = setup(undefined, '已有搜索');
    await vi.advanceTimersByTimeAsync(500);
    expect(state.load).not.toHaveBeenCalled();
    state.keyword.value = 'z';
    await vi.advanceTimersByTimeAsync(200);
    state.keyword.value = 'zhou';
    await vi.advanceTimersByTimeAsync(200);
    state.keyword.value = ' 周杰伦 ';
    await vi.advanceTimersByTimeAsync(249);
    expect(state.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.load).toHaveBeenCalledExactlyOnceWith('周杰伦');
  });

  it('新词还在防抖时，旧请求已经失效', async () => {
    const old = deferred<string[]>();
    const state = setup(vi.fn().mockReturnValue(old.promise));
    state.keyword.value = '周';
    await vi.advanceTimersByTimeAsync(250);
    state.keyword.value = '周杰伦';
    old.resolve(['旧建议']);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.suggestions.value).toEqual([]);
    expect(state.load).toHaveBeenCalledTimes(1);
  });

  it('乱序返回时只显示最新请求，旧成功响应不覆盖新结果', async () => {
    const old = deferred<string[]>();
    const latest = deferred<string[]>();
    const state = setup(vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise));
    state.keyword.value = '周';
    await vi.advanceTimersByTimeAsync(250);
    state.keyword.value = '周杰伦';
    await vi.advanceTimersByTimeAsync(250);
    latest.resolve(['周杰伦 稻香']);
    await vi.advanceTimersByTimeAsync(0);
    old.resolve(['周深']);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.suggestions.value).toEqual(['周杰伦 稻香']);
  });

  it('旧失败响应不清空新结果', async () => {
    const old = deferred<string[]>();
    const state = setup(vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(['新建议']));
    state.keyword.value = '旧';
    await vi.advanceTimersByTimeAsync(250);
    state.keyword.value = '新';
    await vi.advanceTimersByTimeAsync(250);
    old.reject(new Error('旧请求网络失败'));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.suggestions.value).toEqual(['新建议']);
  });

  it('输入改变立即隐藏上一批建议，失败后仍可继续输入请求', async () => {
    const state = setup(vi.fn()
      .mockResolvedValueOnce(['第一批建议'])
      .mockRejectedValueOnce(new Error('断网'))
      .mockResolvedValueOnce(['恢复建议']));
    state.keyword.value = '第一';
    await vi.advanceTimersByTimeAsync(250);
    expect(state.suggestions.value).toEqual(['第一批建议']);
    state.keyword.value = '第二';
    expect(state.suggestions.value).toEqual([]);
    await vi.advanceTimersByTimeAsync(250);
    expect(state.suggestions.value).toEqual([]);
    state.keyword.value = '第三';
    await vi.advanceTimersByTimeAsync(250);
    expect(state.suggestions.value).toEqual(['恢复建议']);
  });

  const cancellationCases = [
    { name: '清空输入', cancel: (state: ReturnType<typeof setup>) => { state.keyword.value = ''; } },
    { name: '空白输入', cancel: (state: ReturnType<typeof setup>) => { state.keyword.value = '  '; } },
    { name: '同词提交', cancel: (state: ReturnType<typeof setup>) => state.cancel() },
    {
      name: '建议点击或路由同步先赋值再取消',
      cancel: (state: ReturnType<typeof setup>) => {
        state.keyword.value = '选中的建议';
        state.cancel();
      },
    },
    { name: '组件卸载', cancel: (state: ReturnType<typeof setup>) => state.scope.stop() },
  ];

  it.each(cancellationCases)('$name 取消未发送的防抖任务', async ({ cancel }) => {
    const state = setup();
    state.keyword.value = '周杰伦';
    await vi.advanceTimersByTimeAsync(200);
    cancel(state);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.load).not.toHaveBeenCalled();
    expect(state.suggestions.value).toEqual([]);
  });

  it.each(cancellationCases)('$name 使在途请求失效，返回后不重新打开列表', async ({ cancel }) => {
    const pending = deferred<string[]>();
    const state = setup(vi.fn().mockReturnValue(pending.promise));
    state.keyword.value = '周杰伦';
    await vi.advanceTimersByTimeAsync(250);
    cancel(state);
    pending.resolve(['周杰伦 稻香']);
    await vi.advanceTimersByTimeAsync(500);
    expect(state.suggestions.value).toEqual([]);
    expect(state.load).toHaveBeenCalledTimes(1);
  });
});

describe('中文输入法', () => {
  it('组合开始取消防抖，组合期间不请求半成品，结束后仅请求完整词', async () => {
    const state = setup();
    state.keyword.value = 'z';
    await vi.advanceTimersByTimeAsync(100);
    state.startComposition();
    state.keyword.value = 'zhou';
    await vi.advanceTimersByTimeAsync(500);
    expect(state.load).not.toHaveBeenCalled();
    // 模拟 Vue v-model 先更新最终值，再触发页面 compositionend 处理。
    state.keyword.value = '周杰伦';
    state.endComposition('周杰伦');
    await vi.advanceTimersByTimeAsync(249);
    expect(state.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.load).toHaveBeenCalledExactlyOnceWith('周杰伦');
  });

  it('组合开始也会使已经发送的旧请求失效', async () => {
    const pending = deferred<string[]>();
    const state = setup(vi.fn().mockReturnValue(pending.promise));
    state.keyword.value = 'zhou';
    await vi.advanceTimersByTimeAsync(250);
    state.startComposition();
    pending.resolve(['半成品建议']);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.suggestions.value).toEqual([]);
  });

  it('忽略组合期间、keyCode 229 及组合结束同一时刻的 Enter，普通 Enter 可提交', async () => {
    const state = setup();
    const enter = { isComposing: false, keyCode: 13 };
    expect(state.canSubmitOnEnter(enter)).toBe(true);
    expect(state.canSubmitOnEnter({ ...enter, isComposing: true })).toBe(false);
    expect(state.canSubmitOnEnter({ ...enter, keyCode: 229 })).toBe(false);
    state.startComposition();
    expect(state.canSubmitOnEnter(enter)).toBe(false);
    state.endComposition('周杰伦');
    expect(state.canSubmitOnEnter(enter)).toBe(false);
    await vi.advanceTimersByTimeAsync(49);
    expect(state.canSubmitOnEnter(enter)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.canSubmitOnEnter(enter)).toBe(true);
  });
});
