import './polyfills';

interface UploadFileView {
  name: string;
  path: string;
  size: number;
  extension: string;
  modifiedAt: number;
  title?: string;
  artist?: string;
  duration?: number;
}

const files = new Map<string, File>();
let fileSequence = 0;

const extensionOf = (name: string) => {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
};

const pickFiles = (mode: 'file' | 'folder', multi = false): Promise<UploadFileView[]> =>
  new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multi || mode === 'folder';
    input.accept = 'audio/*,.mp3,.flac,.m4a,.ogg,.wav,.aac,.ape,.wma,.amr';
    if (mode === 'folder') {
      (input as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory = true;
    }
    input.onchange = () => {
      const selected = Array.from(input.files ?? []);
      const result = selected.map((file) => {
        const path = `mobile-file://${++fileSequence}/${encodeURIComponent(file.name)}`;
        files.set(path, file);
        return {
          name: file.name,
          path,
          size: file.size,
          extension: extensionOf(file.name),
          modifiedAt: file.lastModified || Date.now(),
        };
      });
      resolve(result);
      input.remove();
    };
    input.oncancel = () => {
      resolve([]);
      input.remove();
    };
    input.click();
  });

export const createCloudApi = () => ({
  pickUploadFiles: async (mode: 'file' | 'folder', multi = false) => {
    const selected = await pickFiles(mode, multi);
    return { canceled: selected.length === 0, files: selected };
  },
  readUploadFileData: async (path: string) => {
    const file = files.get(path);
    if (!file) return { ok: false as const, error: '文件已失效，请重新选择' };
    return { ok: true as const, path, size: file.size, data: await file.arrayBuffer() };
  },
  clearUploadFiles: async () => {
    files.clear();
    return { ok: true as const };
  },
});

type CaptureState = {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  chunks: Float32Array[];
  frames: number;
  startedAt: number;
  deviceId: string;
};
let capture: CaptureState | null = null;

const floatToPcm16 = (chunks: Float32Array[]) => {
  const frames = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const output = new Int16Array(frames);
  let offset = 0;
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, chunk[index]));
      output[offset++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
  }
  return output;
};

export const createRecognizeApi = () => ({
  listInputDevices: async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput')
      .map((device, index) => ({
        id: device.deviceId || 'default',
        name: device.label || (index === 0 ? '系统默认麦克风' : `麦克风 ${index + 1}`),
        isDefault: index === 0,
        sampleRate: 16000,
        channels: 1,
      }));
  },
  startAudioCapture: async (request: { source: 'mic' | 'system'; deviceId?: string }) => {
    if (request.source !== 'mic') {
      throw new Error('安卓 WebView 暂不支持系统内录，请选择麦克风');
    }
    if (capture) throw new Error('音频捕获已在进行中');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前设备不支持麦克风捕获');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: request.deviceId && request.deviceId !== 'default' ? { deviceId: request.deviceId } : true,
    });
    const context = new AudioContext({ sampleRate: 16000 });
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const state: CaptureState = {
      stream,
      context,
      source,
      processor,
      chunks: [],
      frames: 0,
      startedAt: Date.now(),
      deviceId: request.deviceId || 'default',
    };
    processor.onaudioprocess = (event) => {
      if (!capture) return;
      const data = new Float32Array(event.inputBuffer.getChannelData(0));
      capture.chunks.push(data);
      capture.frames += data.length;
    };
    source.connect(processor);
    processor.connect(context.destination);
    capture = state;
    return {
      running: true,
      source: 'input' as const,
      deviceId: state.deviceId,
      sampleRate: context.sampleRate,
      channels: 1,
      capturedFrames: 0,
      durationMs: 0,
    };
  },
  stopAudioCapture: async () => {
    const state = capture;
    capture = null;
    if (!state) return new Uint8Array();
    state.processor.disconnect();
    state.source.disconnect();
    state.stream.getTracks().forEach((track) => track.stop());
    await state.context.close();
    return floatToPcm16(state.chunks).buffer;
  },
  cancelAudioCapture: async () => {
    const state = capture;
    capture = null;
    if (!state) return;
    state.processor.disconnect();
    state.source.disconnect();
    state.stream.getTracks().forEach((track) => track.stop());
    await state.context.close();
  },
});

export const createShareApi = () => ({
  copy: async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },
  readClipboard: async () => {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return '';
    }
  },
  captureRectToClipboard: async () => false,
  onOpen: () => () => {},
});
