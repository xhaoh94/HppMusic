/**
 * 个人资料编辑适配层。
 *
 * ## 读写不同名，所以两端只出现在这一个文件里
 *
 * 个性签名读回来在 `detail.descri`，写回去却叫 `signature`
 * （见 `@/api/user` 的 `UpdateUserProfileParams`）。这类字段写错**不会报错**，
 * 只会静默不生效（保存后像是成功了，但值没变）—— 所以必须收在一处，
 * 不要在页面里直接拼 payload。
 *
 * ## 保存只提交**改动过**的字段
 *
 * 接口是平铺字段、整体覆盖语义。全量提交会把没动过的字段也重写一遍：
 * 一旦前端某处读得不准（`birthday` 服务端到底存哪种格式就没完全确定），
 * 就会把用户原本正确的数据改坏。所以逐个 diff，只发有变化的。
 *
 * ## 头像走单独接口
 *
 * `/user/update/avatar` 要 dataURL（图床 multipart 由内置 server 代为完成）。
 * 上传成功后服务端可能返回 `error_code 34236`，那是"**已进审核队列**"的成功态，
 * 内核已经把它转成了 `reviewPending`；这里如实透出，不要当成失败提示。
 */
import { computed } from 'vue';
import type { ComputedRef } from 'vue';
import { updateUserAvatar, updateUserProfile } from '@/api/user';
import type { UpdateUserProfileParams } from '@/api/user';
import { useUserStore } from '@/stores/user';
import type { User } from '@/models/user';

export interface EditableProfile {
  nickname: string;
  signature: string;
  /** 0 女 / 1 男 / 2 保密。（注意 **0 是"女"**，不是"未设置"—— 用 `undefined` 兜底会写错性别） */
  sex: 0 | 1 | 2;
  /** `YYYY-MM-DD`；空串表示未设置 */
  birthday: string;
  province: string;
  city: string;
  avatarUrl: string;
}

/** 展示顺序按参考产品的习惯：男 / 女 / 保密 */
export const SEX_OPTIONS: { value: 0 | 1 | 2; label: string }[] = [
  { value: 1, label: '男' },
  { value: 0, label: '女' },
  { value: 2, label: '保密' },
];

/**
 * 34 个省级行政区。
 *
 * 只做"省级下拉 + 城市手填"，不引完整城市库：城市字段本来就是自由文本，
 * 而上游只把它当展示用。塞一份几十 KB 的行政区划数据进包，收益不抵体积。
 */
export const PROVINCES: string[] = [
  '北京',
  '天津',
  '上海',
  '重庆',
  '河北',
  '山西',
  '辽宁',
  '吉林',
  '黑龙江',
  '江苏',
  '浙江',
  '安徽',
  '福建',
  '江西',
  '山东',
  '河南',
  '湖北',
  '湖南',
  '广东',
  '海南',
  '四川',
  '贵州',
  '云南',
  '陕西',
  '甘肃',
  '青海',
  '台湾',
  '内蒙古',
  '广西',
  '西藏',
  '宁夏',
  '新疆',
  '香港',
  '澳门',
];

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string =>
  typeof value === 'string'
    ? value.trim()
    : value === undefined || value === null
      ? ''
      : String(value);

/**
 * 服务端可能给 `YYYYMMDD`（8 位纯数字），而 `<input type="date">` 只认 `YYYY-MM-DD`；
 * 不转换的话输入框会**静默显示为空**，用户以为没设过生日，一保存就把原值抹了。
 */
const normalizeBirthday = (value: unknown): string => {
  const raw = text(value);
  if (!raw) return '';
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
};

/** 当前账号的可编辑资料（表单初值） */
export const useEditableProfile = (): ComputedRef<EditableProfile> => {
  const user = useUserStore();

  return computed<EditableProfile>(() => {
    const info = user.info as User | null;
    const detail = asRecord(info?.detail);
    const rawSex = Number(detail.sex ?? detail.gender);

    return {
      nickname: text(info?.nickname) || text(info?.username),
      signature: text(detail.descri) || text(detail.signature),
      sex: rawSex === 0 || rawSex === 1 ? rawSex : 2,
      birthday: normalizeBirthday(detail.birthday),
      province: text(detail.province),
      city: text(detail.city),
      avatarUrl: text(info?.pic) || text(info?.userPic),
    };
  });
};

/**
 * 头像压到最长边 `max` 再转 JPEG dataURL。
 *
 * 相册原图动辄几 MB，直接转 dataURL 会同时压垮 WebView 内存和请求体。
 * 512 足够应付所有尺寸的头像展示位（上游给的头像 URL 本身也是 165 的缩略图）。
 *
 * ⚠️ 用 JPEG 而不是 PNG：头像展示位都是圆形裁切，不需要透明通道，
 * 而 PNG 的 base64 体积要大好几倍。
 */
export const toAvatarDataUrl = async (file: File, max = 512): Promise<string> => {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法处理所选图片');
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    bitmap.close?.();
  }
};

export interface SaveResult {
  /** 实际提交的字段个数（用于"没有改动"的提示） */
  changed: number;
  /** 头像进了审核队列（服务端 34236），不是失败 */
  reviewPending: boolean;
}

/**
 * 保存资料：文本字段走 `/user/update`，头像走 `/user/update/avatar`，最后刷新本地资料。
 *
 * 抛错就交给调用方提示 —— 这里不吞异常，因为失败原因（权限、敏感词、图片格式）
 * 对用户是有意义的，吞掉只会变成"点了没反应"。
 */
export const saveProfile = async (
  next: EditableProfile,
  original: EditableProfile,
  avatarFile?: File | null,
): Promise<SaveResult> => {
  const patch: UpdateUserProfileParams = {};

  if (next.nickname.trim() !== original.nickname.trim()) patch.nickname = next.nickname.trim();
  if (next.signature.trim() !== original.signature.trim()) patch.signature = next.signature.trim();
  if (next.sex !== original.sex) patch.sex = next.sex;
  if (next.birthday !== original.birthday) patch.birthday = next.birthday;
  if (next.province !== original.province) patch.province = next.province;
  if (next.city.trim() !== original.city.trim()) patch.city = next.city.trim();

  let changed = 0;
  if (Object.keys(patch).length > 0) {
    await updateUserProfile(patch);
    changed += Object.keys(patch).length;
  }

  let reviewPending = false;
  if (avatarFile) {
    const result = (await updateUserAvatar(
      await toAvatarDataUrl(avatarFile),
      avatarFile.name,
    )) as { reviewPending?: boolean } | undefined;
    reviewPending = Boolean(result?.reviewPending);
    changed += 1;
  }

  if (changed > 0) {
    // 失败不抛：资料已经存下了，拉取失败只影响本页显示，下次进页面还会补拉
    await useUserStore()
      .fetchUserInfo()
      .catch(() => undefined);
  }

  return { changed, reviewPending };
};
