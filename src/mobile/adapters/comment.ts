/**
 * 评论写操作（发表 / 回复 / 删除）。
 *
 * 内核的 `api/comment.ts` 只有**取**数据的一套（列表/楼层/数量/收藏数），
 * 写操作一个都没有，所以这里直接走桥（`window.electron.api.request`）
 * 调上游模块 —— 那三个模块 `server/module` 里都是现成的。
 *
 * ⚠️ 三个接口的参数不一样，别混：
 * | 操作 | 路由 | 必需参数 |
 * |---|---|---|
 * | 发表顶层评论 | `/comment/music/send` | `content` + `mixsongid` |
 * | 回复某条评论 | `/comment/floor/send` | `content` + `special_id` + `tid` |
 * | 删除评论 | `/comment/music/del` | `cid`（楼层回复再加 `tid`） |
 *
 * `tid` 是**被回复的那条评论 id**，`cid` 是要删除的评论 id。
 * 两者都是评论列表里每条的 `id` 字段；`special_id` 也在每条评论上（同一个值）。
 *
 * ## 点赞为什么没有
 *
 * `server/module` 里根本没有点赞模块（`comment_like.js` 之类不存在）。
 * 自己拼签名请求风险太高（签名依赖 `server/util` 的内部状态，绕过内核 request 层
 * 会丢掉 cookie/token 处理），所以**不做点赞** —— 在 UI 上也不渲染可点的心形。
 */
import type { Comment } from '@/models/comment';
import { getBarrage } from '@/api/comment';
import { normalizeBarrageItems, type BarrageItem } from '@/utils/barrage';
import logger from '@/utils/logger';

const request = <T = unknown>(payload: {
  method: 'get' | 'post';
  url: string;
  params?: Record<string, unknown>;
  data?: unknown;
}): Promise<{ status: number; body: Record<string, unknown> }> =>
  window.electron.api.request({
    method: payload.method,
    url: payload.url,
    params: payload.params,
    data: payload.data,
  });

/** 上游成功时 `status === 1`；失败会把原因放在 msg/message/error 里 */
const assertSuccess = (response: { status: number; body: Record<string, unknown> }, fallback: string) => {
  const body = response.body ?? {};
  const succeeded = Number(body.status) === 1 || Number(body.code) === 200;
  if (succeeded) return;

  const raw = body.msg ?? body.message ?? body.error ?? body.errmsg;
  const message = typeof raw === 'string' && raw.trim() ? raw.trim() : fallback;
  logger.warn('CommentWrite', `${fallback} → ${message}`, body);
  throw new Error(message);
};

/** 发表顶层评论。`mixsongid` 用当前曲目的 `Song.mixSongId`（与读评论同一个 id） */
export const sendMusicComment = async (mixSongId: string, content: string) => {
  const text = content.trim();
  if (!text) throw new Error('评论内容不能为空');
  const response = await request({
    method: 'get',
    url: '/comment/music/send',
    params: { content: text, mixsongid: mixSongId },
  });
  assertSuccess(response, '发表评论失败');
};

/**
 * 回复某条评论。
 *
 * `specialId` 与 `targetId` 都从被回复的那条评论上取（评论条目自带这两个字段），
 * 不需要额外请求 —— 这也是为什么回复入口要挂在"某条评论"上。
 */
export const replyComment = async (comment: Comment, content: string) => {
  const text = content.trim();
  if (!text) throw new Error('回复内容不能为空');
  const specialId = String(
    (comment as unknown as { specialId?: string; special_id?: string }).specialId ??
      (comment as unknown as { special_id?: string }).special_id ??
      '',
  );
  const targetId = String(comment.id ?? '');
  if (!specialId || !targetId) throw new Error('缺少回复所需的评论标识');

  const response = await request({
    method: 'get',
    url: '/comment/floor/send',
    params: { content: text, special_id: specialId, tid: targetId },
  });
  assertSuccess(response, '回复失败');
};

/** 删除自己的评论；`tid` 用于删除某条回复（顶层评论不需要） */
export const deleteComment = async (cid: string, tid?: string) => {
  const id = String(cid ?? '').trim();
  if (!id) throw new Error('缺少评论 ID');
  const response = await request({
    method: 'get',
    url: '/comment/music/del',
    params: tid ? { cid: id, tid } : { cid: id },
  });
  assertSuccess(response, '删除评论失败');
};

/**
 * 拉取歌曲弹幕。
 *
 * 内核 `api/comment.ts` 的 `getBarrage` 返回的是**原始响应**（弹幕挂在 `list` 上），
 * 解析交给内核的 `normalizeBarrageItems` —— 它负责取 `content` / `user_id`、丢掉空串、
 * 并按 `BARRAGE_LIMIT`（100）截断。这几步在移动端重写一遍没有意义，而且会和桌面端
 * 的解析规则漂移。
 *
 * `hash` 必须是 32 位歌曲 hash（`Song.hash`），**不是** `mixSongId`。
 */
export const fetchSongBarrage = async (hash: string): Promise<BarrageItem[]> => {
  const response = (await getBarrage('song', hash)) as { list?: unknown };
  return normalizeBarrageItems(response?.list);
};
