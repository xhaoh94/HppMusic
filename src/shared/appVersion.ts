/**
 * 版本号比较。
 *
 * 本项目同时存在这几种写法，必须都能正确比较，否则更新检查会误判（把旧版当新版、
 * 或是永远提示「已是最新」）：
 * - 应用内版本：`0.1.0-mobile.1`（构建时由 __APP_VERSION__ 拼上 -mobile.N）
 * - 发布 tag：`v0.1.0`
 * - 可能出现的预发布：`1.2.0-beta.2`
 *
 * 规则：先比数字段（缺失按 0 补齐），数字相同再比预发布标识 ——
 * 有预发布标识的**低于**同号正式版（语义化版本约定）。
 */
export interface ParsedVersion {
  numbers: number[];
  prerelease: string[];
}

const VERSION_PATTERN = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?/;

export const parseVersion = (input: string): ParsedVersion | null => {
  const match = VERSION_PATTERN.exec(String(input ?? '').trim());
  if (!match) return null;
  return {
    numbers: match[1].split('.').map((part) => Number.parseInt(part, 10) || 0),
    prerelease: match[2] ? match[2].split('.').filter(Boolean) : [],
  };
};

/** 返回 >0 表示 a 比 b 新，<0 表示更旧，0 表示相同。 */
export const compareVersions = (a: string, b: string): number => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;

  const length = Math.max(left.numbers.length, right.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  // 数字相同：正式版比预发布版新（1.0.0 > 1.0.0-beta）
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;

  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);
    const leftIsNumber = Number.isFinite(leftNumber) && String(leftNumber) === leftPart;
    const rightIsNumber = Number.isFinite(rightNumber) && String(rightNumber) === rightPart;
    if (leftIsNumber && rightIsNumber) return leftNumber > rightNumber ? 1 : -1;
    if (leftIsNumber) return -1;
    if (rightIsNumber) return 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
};

/** 候选版本是否比当前版本新。解析失败时一律判为「不是更新」，避免误提示。 */
export const isNewerVersion = (candidate: string, current: string): boolean => {
  if (!parseVersion(candidate) || !parseVersion(current)) return false;
  return compareVersions(candidate, current) > 0;
};

/**
 * 去掉构建时拼上的内部后缀（`0.1.1-mobile.3` → `0.1.1`）。
 *
 * `-mobile.N` 是每次构建自增的内部编号，不是语义化版本的预发布标识；
 * 直接拿去比较会把「同一个 release」误判成新版本（实测：已装 0.1.1-mobile.1，
 * 对 tag v0.1.1 会一直提示可更新）。
 */
export const stripInternalBuild = (version: string): string =>
  String(version ?? '').replace(/-mobile(\.\d+)?$/i, '');

/** 发布说明的轻量清洗：去掉 Markdown 标题标记、压缩多余空行。 */
export const formatReleaseNotes = (raw: string): string =>
  String(raw ?? '')
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s*/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
