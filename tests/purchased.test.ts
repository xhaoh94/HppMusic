import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getPurchasedAlbum, getPurchasedSongs } from '@/api/purchased';
import {
  extractPurchasedAlbums,
  extractPurchasedSongs,
  getPurchasedAlbumsPage,
  getPurchasedSongsPage,
} from '../src/mobile/adapters/purchased';

vi.mock('@/api/purchased', () => ({
  getPurchasedAlbum: vi.fn(),
  getPurchasedSongs: vi.fn(),
}));

const song = (id: number, title = `歌曲${id}`) => ({
  mixsongid: id,
  audio_id: id,
  audio_name: title,
  author_name: '歌手',
  album_id: 900 + id,
  album_name: '专辑',
  album_sizable_cover: `//image/${id}/{size}.jpg`,
  hash: `hash-${id}`,
  timelength: 180000,
});

const album = (id: number, name = `专辑${id}`) => ({
  AlbumId: id,
  AlbumName: name,
  SingerName: '歌手',
  Image: `//image/${id}/{size}.jpg`,
  SongCount: 10,
});

beforeEach(() => vi.clearAllMocks());

describe('已购响应映射', () => {
  it('映射 get_goods 的 data.list，并跨重复条目去重', () => {
    const result = extractPurchasedSongs({
      status: 1,
      data: {
        total: 2,
        list: [song(101), song(101), song(102)],
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: '101',
      title: '歌曲101',
      artist: '歌手',
      albumId: '1001',
      duration: 180,
    });
    expect(result[0].coverUrl).toContain('https://image/101/400.jpg');
  });

  it('映射 get_album_goods 的 data.album_list，并兼容字符串字段', () => {
    const result = extractPurchasedAlbums({
      status: 1,
      data: {
        total_count: '2',
        album_list: [album(7), album(7), album(8, '另一张')],
      },
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 7, name: '专辑7', singerName: '歌手', songCount: 10 });
    expect(result[0].pic).toBe('https://image/7/400.jpg');
  });

  it('兼容接口把列表放在 data.goods / data.albums 的响应', () => {
    expect(extractPurchasedSongs({ status: 1, data: { goods: [song(1)] } })).toHaveLength(1);
    expect(extractPurchasedAlbums({ status: 1, data: { albums: [album(1)] } })).toHaveLength(1);
  });
});

describe('已购分页', () => {
  it('固定每页 30 条，按 total 判断下一页且不提前拉取', async () => {
    vi.mocked(getPurchasedSongs).mockResolvedValue({
      status: 1,
      data: { total: 31, list: [song(1)] },
    });
    vi.mocked(getPurchasedAlbum).mockResolvedValue({
      status: 1,
      data: { total: 30, album_list: [album(1)] },
    });

    const songs = await getPurchasedSongsPage(1);
    const albums = await getPurchasedAlbumsPage(1);

    expect(getPurchasedSongs).toHaveBeenCalledExactlyOnceWith(1, 30);
    expect(getPurchasedAlbum).toHaveBeenCalledExactlyOnceWith(1, 30);
    expect(songs).toMatchObject({ total: 31, hasMore: true });
    expect(albums).toMatchObject({ total: 30, hasMore: false });
  });

  it('total/has_more 表示后面还有页时，空页仍保留 hasMore', async () => {
    vi.mocked(getPurchasedSongs).mockResolvedValueOnce({
      status: 1,
      data: { total: 61, list: [] },
    });
    vi.mocked(getPurchasedAlbum).mockResolvedValueOnce({
      status: 1,
      data: { has_more: true, album_list: [] },
    });

    await expect(getPurchasedSongsPage(1)).resolves.toMatchObject({
      items: [],
      total: 61,
      hasMore: true,
    });
    await expect(getPurchasedAlbumsPage(1)).resolves.toMatchObject({
      items: [],
      hasMore: true,
    });
  });

  it('没有 total 时按本页原始数量判断，并把业务失败变成可重试错误', async () => {
    const pageItems = Array.from({ length: 30 }, (_, index) => song(index + 1));
    vi.mocked(getPurchasedSongs).mockResolvedValueOnce({ status: 1, data: { list: pageItems } });
    expect((await getPurchasedSongsPage(1)).hasMore).toBe(true);

    vi.mocked(getPurchasedSongs).mockResolvedValueOnce({
      status: 0,
      msg: '登录已过期',
      data: { list: [] },
    });
    await expect(getPurchasedSongsPage(2)).rejects.toThrow('登录已过期');
  });
});

describe('已购去重不丢数据', () => {
  it('缺 hash/id 的单曲不会被丢弃，而是回退到「歌名+歌手」', async () => {
    const { dedupePurchasedSongs, purchasedSongKey } = await import(
      '../src/mobile/adapters/purchased'
    );
    const noId = { id: '', hash: '', title: '无标识歌曲', name: '无标识歌曲', artist: '某歌手', album: '', duration: 100, coverUrl: '', audioUrl: '', mixSongId: '' } as any;
    const key = purchasedSongKey(noId, 0);
    expect(key).not.toBe('');
    expect(key.startsWith('soft:')).toBe(true);
    expect(dedupePurchasedSongs([noId])).toHaveLength(1);
  });

  it('两条元数据全空的行不会被压成一条（行号兜底）', async () => {
    const { dedupePurchasedSongs, purchasedSongKey } = await import(
      '../src/mobile/adapters/purchased'
    );
    const empty = () => ({ id: '', hash: '', title: '', name: '', artist: '', album: '', duration: 0, coverUrl: '', audioUrl: '', mixSongId: '' }) as any;
    expect(purchasedSongKey(empty(), 0)).toBe('row:0');
    expect(purchasedSongKey(empty(), 1)).toBe('row:1');
    expect(dedupePurchasedSongs([empty(), empty()])).toHaveLength(2);
  });

  it('缺 id 的多张专辑不会被合并成一条，同 id 仍然去重', async () => {
    const { dedupePurchasedAlbums, purchasedAlbumKey } = await import(
      '../src/mobile/adapters/purchased'
    );
    const noIdAlbum = (name: string) => ({ id: 0, name, singerName: '歌手' }) as any;
    expect(purchasedAlbumKey(noIdAlbum('甲'))).not.toBe(purchasedAlbumKey(noIdAlbum('乙')));
    expect(dedupePurchasedAlbums([noIdAlbum('甲'), noIdAlbum('乙')])).toHaveLength(2);
    expect(dedupePurchasedAlbums([noIdAlbum('甲'), noIdAlbum('甲')])).toHaveLength(1);
  });
});
