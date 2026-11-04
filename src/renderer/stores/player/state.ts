import type { Song } from '@/models/song';
import type { TrackLoudness } from '@/utils/player';
import type { AudioEffectValue, AudioQualityValue, PlayMode } from '../../types';
import type {
  ClimaxMark,
  EnginePlaybackState,
  PlaybackDiagnostics,
  PlaybackIntent,
  PlaybackNotice,
  PlaybackSource,
  PlaybackSourceKind,
} from './types';
import { DEFAULT_PLAYER_VOLUME } from '../../../shared/playback';
import { createSleepTimerState } from './sleepTimer';

const createPlaybackIntent = (): PlaybackIntent => ({
  seq: 0,
  trackId: null,
  sourceQueueId: null,
  shouldPlay: false,
  phase: 'idle',
  startedAt: 0,
});

const createEnginePlaybackState = (): EnginePlaybackState => ({
  status: 'idle',
  trackId: null,
  updatedAt: 0,
});

const createPlaybackDiagnostics = (): PlaybackDiagnostics => ({
  core: null,
  ao: null,
  packetCache: null,
  output: null,
  graph: null,
});

export const createPlayerState = () => ({
  sleepTimer: createSleepTimerState(),
  isLyricViewOpen: false,
  volume: DEFAULT_PLAYER_VOLUME,
  lastNonZeroVolume: DEFAULT_PLAYER_VOLUME,
  currentTime: 0,
  // EOF survives pause events; resuming an exhausted source must reload it.
  playbackEnded: false,
  currentTimeUpdatedAt: 0,
  // Monotonic ordering for native buffering and actual-output-progress events.
  nativePlaybackEventRevision: 0,
  nativePlaybackProgressRevision: 0,
  duration: 0,
  playbackRate: 1,
  playMode: 'list' as PlayMode,
  equalizerGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] as number[],
  currentTrackId: null as string | null,
  currentSourceQueueId: null as string | null,
  lastError: '' as string | null,
  currentPlaylist: null as Song[] | null,
  currentAudioUrl: '' as string,
  currentPlaybackSource: null as PlaybackSource | null,
  currentAudioCandidateUrls: [] as string[],
  currentAudioCandidateSources: [] as PlaybackSource[],
  currentAudioCandidateIndex: -1,
  currentResolvedAudioQuality: null as AudioQualityValue | null,
  currentResolvedAudioEffect: 'none' as AudioEffectValue,
  currentResolvedAudioLoudness: null as TrackLoudness | null,
  currentResolvedSourceKind: 'catalog' as PlaybackSourceKind,
  nativeTrackSeq: null as number | null,
  supersededNativeTrackSeq: null as number | null,
  audioEffect: 'none' as AudioEffectValue,
  /**
   * 在这个时间点之前到达的 EOF 视为 seek 引起的假结束，直接丢弃。
   *
   * ⚠️ 用时间戳而不是"布尔 + setTimeout 复位"：页面退到后台后 Chromium 会把
   * 定时器节流到约 1 次/分钟，布尔量会一直停在 true，这段时间里**真实的** EOF
   * 也会被当成假结束吞掉 —— 表现为"播完不切歌、原地停住"。
   * 0 表示不忽略。
   */
  recentSeekIgnoreEndUntil: 0,
  settingsWatcherRegistered: false,
  pendingSettingRefresh: false,
  audioSourceRefreshRequestSeq: null as number | null,
  audioSourceRefreshQuality: null as AudioQualityValue | null,
  climaxMarks: [] as ClimaxMark[],
  appliedOutputDeviceId: 'default' as string,
  _lastAppliedExclusive: false,
  currentAudioQualityOverride: null as AudioQualityValue | null,
  currentCatalogSourceOverrideTrackId: null as string | null,
  currentCloudSourceOverrideTrackId: null as string | null,
  playbackRequestSeq: 0,
  climaxRequestSeq: 0,
  currentTrackSnapshot: null as Song | null,
  historyUploadCommitted: false,
  historyUploadTrackId: null as string | null,
  historyLocalRecorded: false,
  autoNextTimer: null as number | null,
  autoNextAttempts: 0,
  autoNextSourceTrackId: null as string | null,
  // Certain synchronized playback contexts must wait for their remote controller instead.
  autoNextSuppressed: false,
  audioEffectError: '',
  audioEffectApplying: false,
  playbackNotice: null as PlaybackNotice | null,
  shuffleQueue: null as number[] | null,
  shuffleQueueLength: 0,
  shufflePlayed: new Set<number>(),
  shuffleHistory: [] as string[],
  seekTargetTime: null as number | null,
  nativeSeekActive: false,
  nativeSeekGeneration: null as number | null,
  seekTimestamp: 0,
  isResuming: false,
  playbackIntent: createPlaybackIntent(),
  enginePlayback: createEnginePlaybackState(),
  playbackDiagnostics: createPlaybackDiagnostics(),
  // 原生换源护栏：开始加载时置 true，player 回报 file-loaded（新文件真正加载完成）后置 false。
  // 期间 timeUpdate/durationChange 收到的多为上一首在 loadFile 替换前后的残留回报，一律丢弃，
  // 避免进度条切歌时先跳到旧值再归零。
  awaitingTrackLoad: false,
  // 卡死恢复：恢复期间 UI 停在断点位置，忽略 reload 过程中 player 回报的归零/回跳值，避免进度条跳动
  stallRecovering: false,
  stallRecoverTarget: 0,
  stallRecoverDeadline: 0,
  stallRecoverAttempts: 0,
  stallRecoverTrackId: null as string | null,
});

export type PlayerState = ReturnType<typeof createPlayerState>;
