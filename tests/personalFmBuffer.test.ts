import { describe, expect, it } from 'vitest';
import { excludePlayedFmRecommendations } from '../src/shared/personalFmBuffer';

describe('私人FM推荐去重', () => {
  it('补推荐时过滤已提交历史和批内重复，不修改可供上一首使用的历史', () => {
    const history = [{ key: 'a' }, { key: 'b' }];
    const incoming = [{ key: 'b' }, { key: 'c' }, { key: 'c' }, { key: '' }, { key: 'd' }];
    expect(excludePlayedFmRecommendations(history, incoming, track => track.key)).toEqual([{ key: 'c' }, { key: 'd' }]);
    expect(history).toEqual([{ key: 'a' }, { key: 'b' }]);
    expect(incoming).toHaveLength(5);
  });
});
