/**
 * 个人资料适配层。
 *
 * 把 `user.info` 那三层（顶层 / `detail` / `vip`）映射成页面可直接渲染的结构。
 * 与 `adapters/player.ts` 同样的理由：页面只拿语义化字段，不直接啃原始 payload。
 *
 * ## 格式化一律复用内核，不在移动端重写
 *
 * | 需求 | 内核提供 |
 * |---|---|
 * | 乐龄（按本地日历算**完整月份**，月末对齐） | `@shared/profileStats` 的 `formatAccountAge` |
 * | 听歌时长分段显示 | 同上的 `formatListeningDuration` |
 * | 等级 / 升级进度 | 同上的 `getGradeProgress` |
 * | VIP 判定 | `@/utils/accountVip` 的 `getAccountVipStatus`（超级VIP 是 `user_type` 的**位运算**，豪华VIP 是 `vip_type === 6`，概念/畅听在 `busi_vip` 数组里按 `product_type` 找） |
 * | 昵称旁的会员标识 | `@/utils/userIdentity` 的 `getAccountDisplay` |
 *
 * 这些规则重写一遍只会和桌面端漂移（尤其乐龄的月份算法和 VIP 的位运算）。
 *
 * ## 字段名（设备实测确认，与旧项目一致）
 *
 * · 乐龄起算用 `detail.rtime`（Unix **秒**）；`reg_time` 是已经格式化好的字符串，不是时间戳。
 * · 访客数是 `detail.hvisitors` —— `visitors` 那个字段恒为 0。
 * · 听歌总时长优先 `detail.d_sec`（秒），回落 `detail.duration`（**分钟**）。
 *   实测这个账号 `d_sec` 是 null、`duration` 是 6379 → 4 天 10 小时 19 分钟，
 *   与参考产品显示一致，所以回落顺序不能反。
 */
import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import type { User } from '@/models/user';
import { useUserStore } from '@/stores/user';
import { getAccountDisplay } from '@/utils/userIdentity';
import { getAccountVipStatus } from '@/utils/accountVip';
import { formatAccountAge, formatListeningDuration, getGradeProgress } from '@shared/profileStats';

/** 会员卡的配色分类（模板里映射成不同图标色，与参考产品一致） */
export type MembershipKind = 'super' | 'deluxe' | 'concept' | 'music';

export interface MembershipCard {
  key: MembershipKind;
  label: string;
  kind: MembershipKind;
  /** 到期日期（`2026-11-26`）；未开通是空串 */
  expiresAt: string;
  active: boolean;
}

export interface ProfileSummary {
  nickname: string;
  avatarUrl: string;
  userId: string;
  /** 个性签名（旧项目字段叫 descri） */
  signature: string;
  /** 昵称旁的会员标识（超级VIP / 豪华VIP / 概念VIP / 畅听VIP），没有就是空 */
  vipLabel: string;
  vipKind: MembershipKind | '';
  /** 地域标签（IP 归属地，如「广东」） */
  regionTag: string;
  grade: number | null;
  friends: number;
  follows: number;
  fans: number;
  visitors: number;
  gender: string;
  accountAge: string;
  location: string;
  listening: string;
  memberships: MembershipCard[];
  /** 是否已经拿到档案（没登录或还没拉到时，页面显示「—」而不是 0） */
  hasDetail: boolean;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : value === undefined || value === null ? '' : String(value);

/** 取第一个能转成有限数的字段，全都取不到就返回 0 */
const count = (source: Record<string, unknown>, keys: string[]): number => {
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return Math.max(0, Math.trunc(number));
  }
  return 0;
};

/**
 * 到期日期（`2026-11-26`）。
 *
 * 只要年月日：会员卡的横向空间有限，带上时分（`13:55`）会把两列挤到换行，
 * 而“哪天到期”才是要看的信息。
 *
 * 手动拼而不是 `toLocaleString()`：Android WebView 的输出随系统语言变
 * （`2026/11/26 下午1:55` 之类），同一屏里两张卡片的格式还可能不一致。
 *
 * 上游给的 `vip_end_time` 是 `"2026-11-26 13:55:46"`，**不是** ISO 格式（缺 T），
 * 但 `new Date()` 在各引擎上都能按本地时间解析。解不开就原样带出去，不隐藏信息。
 */
export const formatVipDate = (endTime: unknown): string => {
  const value = text(endTime);
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * 会员卡。
 *
 * 超级/豪华是**顶层布尔**（`su_vip_end_time` / `vip_end_time`），概念/畅听是
 * `busi_vip` 数组里的产品项（各自带自己的 `vip_end_time`）—— 四条路不一样，
 * 所以到期时间要分别取，不能统一读一个字段。
 */
const buildMemberships = (
  vip: Record<string, unknown>,
): MembershipCard[] => {
  const status = getAccountVipStatus(vip);
  /** 四种会员的到期时间**字段各不相同**，不能统一读一个 */
  const card = (
    key: MembershipKind,
    label: string,
    active: boolean,
    endTime: unknown,
  ): MembershipCard => ({
    key,
    label,
    kind: key,
    expiresAt: active ? formatVipDate(endTime) : '',
    active,
  });

  return [
    // 超级VIP / 豪华VIP：顶层字段
    card('super', '超级VIP', status.superVip, vip.su_vip_end_time),
    card('deluxe', '豪华VIP', status.deluxeVip, vip.vip_end_time),
    // 概念 / 畅听：busi_vip 数组里的产品项，各自带自己的 vip_end_time
    card('concept', '概念会员', Boolean(status.conceptVip), status.conceptVip?.vip_end_time),
    card('music', '畅听会员', Boolean(status.musicVip), status.musicVip?.vip_end_time),
  ];
};

export const useProfileSummary = (): ComputedRef<ProfileSummary> => {
  const user = useUserStore();

  return computed<ProfileSummary>(() => {
    const info = user.info as User | null;
    const detail = asRecord(info?.detail);
    const vip = asRecord(info?.vip);
    const display = getAccountDisplay(info);

    const province = text(detail.province);
    const city = text(detail.city);

    const genderValue = Number(detail.gender ?? detail.sex);
    const gender = genderValue === 1 ? '男' : genderValue === 0 ? '女' : '保密';

    return {
      nickname: text(info?.nickname) || text(info?.username) || '未登录',
      avatarUrl: text(info?.pic) || text(info?.userPic),
      userId: text(info?.userid),
      signature: text(detail.descri) || text(detail.signature),
      vipLabel: display.membership?.label ?? '',
      vipKind: (display.membership?.kind as MembershipKind | undefined) ?? '',
      regionTag: text(detail.loc),
      grade: getGradeProgress(detail).grade,
      friends: count(detail, ['friends', 'friend_count', 'friend_total']),
      follows: count(detail, ['follows', 'follow_count']),
      fans: count(detail, ['fans']),
      // hvisitors 才是真的访客数，visitors 恒为 0
      visitors: count(detail, ['hvisitors']),
      gender,
      accountAge: formatAccountAge(detail.rtime),
      location: province && city ? `${province}·${city}` : province || city || '—',
      listening: info ? formatListeningDuration(detail.d_sec, detail.duration) : '—',
      memberships: buildMemberships(vip),
      hasDetail: Object.keys(detail).length > 0,
    };
  });
};
