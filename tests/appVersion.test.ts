import { describe, expect, it } from 'vitest';
import { compareVersions, isNewerVersion, parseVersion } from '../src/shared/appVersion';

describe('版本号比较', () => {
  it('解析 v 前缀与 -mobile.N 后缀', () => {
    expect(parseVersion('v0.1.0')?.numbers).toEqual([0, 1, 0]);
    expect(parseVersion('0.1.0-mobile.1')?.prerelease).toEqual(['mobile', '1']);
    expect(parseVersion('垃圾')).toBeNull();
  });

  it('数字段逐位比较，位数不同按 0 补齐', () => {
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
  });

  it('同号正式版高于预发布版', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(-1);
  });

  it('应用内版本 0.1.0-mobile.1 与发布 tag v0.1.0 视为同一版本', () => {
    expect(isNewerVersion('0.1.0', '0.1.0-mobile.1')).toBe(true);
    expect(isNewerVersion('0.0.9', '0.1.0-mobile.1')).toBe(false);
    expect(isNewerVersion('v0.1.1', '0.1.0-mobile.1')).toBe(true);
  });

  it('无法解析时保守判定为“不是更新”', () => {
    expect(isNewerVersion('', '0.1.0')).toBe(false);
    expect(isNewerVersion('latest', '0.1.0')).toBe(false);
  });
});

describe('构建后缀与发布说明', () => {
  it('去掉内部构建后缀后再比较，同一发布不算新版本', async () => {
    const { stripInternalBuild } = await import('../src/shared/appVersion');
    expect(stripInternalBuild('0.1.1-mobile.1')).toBe('0.1.1');
    expect(stripInternalBuild('0.1.1-mobile')).toBe('0.1.1');
    expect(stripInternalBuild('0.1.1-beta.2')).toBe('0.1.1-beta.2');
    expect(isNewerVersion('0.1.1', stripInternalBuild('0.1.1-mobile.1'))).toBe(false);
    expect(isNewerVersion('0.1.2', stripInternalBuild('0.1.1-mobile.1'))).toBe(true);
  });

  it('发布说明去掉 Markdown 标题并压缩空行', async () => {
    const { formatReleaseNotes } = await import('../src/shared/appVersion');
    expect(formatReleaseNotes('## v1\n\n\n### 变更\n- a\n')).toBe('v1\n\n变更\n- a');
  });
});
