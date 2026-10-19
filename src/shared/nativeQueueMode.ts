import type { PlayMode } from './playback';

/** 桥接约定：0 顺序、1 单曲循环、2 列表循环、3 随机（列表循环 + shuffle）。 */
export const nativeQueueMode = (mode: PlayMode): number => {
  switch (mode) {
    case 'single': return 1;
    case 'list': return 2;
    case 'random': return 3;
    default: return 0;
  }
};

/** 先准备当前位置之后的歌，再准备之前的歌；原生按队列索引插入，保持真实列表顺序。 */
export const nativeQueueCandidateIndices = (length: number, currentIndex: number): number[] => {
  if (currentIndex < 0 || currentIndex >= length) return [];
  return [
    ...Array.from({ length: length - currentIndex - 1 }, (_, index) => currentIndex + index + 1),
    ...Array.from({ length: currentIndex }, (_, index) => index),
  ];
};
