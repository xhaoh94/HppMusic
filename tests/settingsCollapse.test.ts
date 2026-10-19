import { beforeEach, describe, expect, it } from 'vitest';
import {
  isSectionCollapsed,
  resetSectionCollapse,
  setSectionCollapsed,
} from '../src/mobile/composables/useSettingsCollapse';

beforeEach(() => resetSectionCollapse());

describe('设置分组折叠状态（仅本次运行内记忆）', () => {
  it('默认按传入的 fallback（外观展开、其余收起）', () => {
    expect(isSectionCollapsed('外观', false)).toBe(false);
    expect(isSectionCollapsed('播放', true)).toBe(true);
  });

  it('用户展开/收起后按记忆值返回，且不受默认值影响', () => {
    setSectionCollapsed('播放', false);
    expect(isSectionCollapsed('播放', true)).toBe(false);
    setSectionCollapsed('外观', true);
    expect(isSectionCollapsed('外观', false)).toBe(true);
  });

  it('不同分组互不影响', () => {
    setSectionCollapsed('播放', false);
    expect(isSectionCollapsed('音质', true)).toBe(true);
    expect(isSectionCollapsed('播放', true)).toBe(false);
  });

  it('重置后回到默认（等同 App 重启）', () => {
    setSectionCollapsed('播放', false);
    resetSectionCollapse();
    expect(isSectionCollapsed('播放', true)).toBe(true);
  });
});
