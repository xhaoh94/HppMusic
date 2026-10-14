/**
 * 本地音频夹具：起一个只服务一个合成 WAV 的 HTTP 服务。
 *
 * ## 为什么需要
 *
 * 验证原生播放链路（Media3 → AudioTrack → 通知栏）时，如果拿外部 URL 当音源，
 * 结果就依赖那台主机在这个网络下通不通 —— 实测 Google 的测试音频域名
 * `storage.googleapis.com/exoplayer-test-media-0/play.mp3` 在当前网络下**ping 通但
 * HTTPS 被重置**，于是只能看到 ExoPlayer 的 "Source error"，分不清是引擎坏了
 * 还是网络坏了。
 *
 * 这里现场合成一段正弦波 WAV（无版权、无外部依赖、字节可控），
 * 由本机 HTTP 服务提供，模拟器用 `http://10.0.2.2:<port>/tone.wav` 访问
 * （10.0.2.2 是 Android 模拟器访问宿主机的固定地址）。
 *
 * 用法：
 *   node scripts/dev/serve-audio-fixture.mjs            # 默认端口 8899
 *   node scripts/dev/serve-audio-fixture.mjs --port 9000
 *
 * 然后在设备侧：
 *   bash scripts/device-forward.sh
 *   node scripts/device-eval.mjs "(async () => { const p = window.electron.player; \
 *     const id = await p.beginSourceChange(); \
 *     const loaded = await p.load('http://10.0.2.2:8899/tone.wav', id); \
 *     await p.play(id); await new Promise(r => setTimeout(r, 2000)); \
 *     const s = await p.getState(); await p.pause(); return JSON.stringify({ loaded, state: s }); })()"
 *
 * 期望：`loaded.duration` 约 5000（毫秒），`state.playing` 在播放期间为 true，
 * `state.timePos` 随时间增长 —— 三者同时成立才说明解码与输出真的在跑。
 */
import { createServer } from 'node:http';

const portIndex = process.argv.indexOf('--port');
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 8899;

const SAMPLE_RATE = 44100;
const SECONDS = 5;
const FREQUENCY = 440;

/** 生成 16bit 立体声 PCM 的 WAV（前 2 秒 440Hz，后 3 秒静音 —— 便于听出"确实在放"） */
const buildWav = () => {
  const frames = SAMPLE_RATE * SECONDS;
  const channels = 2;
  const bytesPerSample = 2;
  const dataSize = frames * channels * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * channels * bytesPerSample, 28);
  buffer.writeUInt16LE(channels * bytesPerSample, 32);
  buffer.writeUInt16LE(8 * bytesPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  const toneFrames = SAMPLE_RATE * 2;
  for (let frame = 0; frame < frames; frame += 1) {
    // 音量做个衰减包络，避免突然截断产生"咔"声
    const value =
      frame < toneFrames
        ? Math.sin((2 * Math.PI * FREQUENCY * frame) / SAMPLE_RATE) *
          0.3 *
          (1 - frame / toneFrames)
        : 0;
    const sample = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    const offset = 44 + frame * channels * bytesPerSample;
    buffer.writeInt16LE(sample, offset);
    buffer.writeInt16LE(sample, offset + 2);
  }

  return buffer;
};

const wav = buildWav();

const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }

  /**
   * POST 回显：返回实际收到的请求体字节数。
   *
   * 用来验证「原生 HTTP（CapacitorHttp）能不能正确传二进制请求体」——
   * 听歌识曲需要 POST 320KB 的 PCM，而 JS bridge 的 JSON 序列化会吞掉二进制，
   * 靠业务接口的报错反推很绕；这里直接看字节数最直接。
   */
  if (request.url?.startsWith('/echo') && request.method === 'POST') {
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
    });
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ bytes, contentType: request.headers['content-type'] ?? '' }));
    });
    return;
  }

  if (request.url?.startsWith('/tone.wav')) {
    response.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': String(wav.length),
      // ExoPlayer 会先发 Range 请求探测；不带这个头部分播放器会直接报错
      'Accept-Ranges': 'bytes',
    });
    response.end(wav);
    return;
  }
  if (request.url === '/health') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('ok');
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[audio-fixture] 已启动：http://127.0.0.1:${PORT}/tone.wav（${SECONDS}s / ${FREQUENCY}Hz，${wav.length} 字节）`);
  console.log(`[audio-fixture] 模拟器内请用：http://10.0.2.2:${PORT}/tone.wav`);
  console.log('[audio-fixture] Ctrl+C 停止');
});
