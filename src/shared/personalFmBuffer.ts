/** FM 的新推荐不应把已提交到播放历史的歌曲再次塞回缓冲；显式上一首仍从历史读取。 */
export const excludePlayedFmRecommendations = <T>(
  history: readonly T[],
  incoming: readonly T[],
  keyOf: (track: T) => string,
): T[] => {
  const seen = new Set(history.map(keyOf));
  return incoming.filter((track) => {
    const key = keyOf(track);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
