package com.hppmusic.app;

import androidx.media3.common.C;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.audio.BaseAudioProcessor;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Arrays;
import java.util.concurrent.CompletableFuture;

/**
 * Media3 PCM16 DSP chain: 10-band peaking EQ → loudness normalization gain → IR convolution.
 *
 * 之前这里只有卷积。渲染层的均衡器 / 音量均衡 / 音效引擎占位符全部落在桥接层空函数上，
 * 结果是「设置页能拖、声音毫无变化」。现在把三项里真正能在手机上实现的两项做进来：
 *
 * 1. 10 段峰值均衡器：频点与渲染层 EffectPopover 的 31Hz~16kHz 完全一致，
 *    每段 ±12dB（UI 也是 clamp 到 ±12），Q=1.414（十倍频程带宽）。
 * 2. 响度归一化增益：渲染层已用 EBU R128 算出 gainDb（player.ts → setNormalizationGain），
 *    原生只负责换成线性增益并与 EQ 一起作用。
 * 3. IR 卷积：沿用原有实现（上限 4096 taps，超出的截断）。
 *
 * VPF / Provider 资源依然在服务层就被拒绝：那是独立 DSP Provider 能力，不是本处理器能替代的。
 *
 * 实时线程约束：参数写入全部是 volatile 字段替换，且**只发生在主线程/音效加载线程**；
 * 音频线程（queueInput）只读快照、不加锁。需要重建的数组（history / filterState / bassState）
 * 一律由主线程置 dspStateDirty、音频线程在缓冲区顶部重建 —— 跨线程直接换数组会与
 * 逐帧读取竞态：history 被换成更小的尺寸时音频线程当场越界（播放中断）。
 */
public final class EchoDspAudioProcessor extends BaseAudioProcessor {
    private static final int MAX_TAPS = 4096;
    private static final float DEFAULT_MIX = 1.0f;
    /** 与渲染层 10 段均衡器频点保持一致，顺序即 UI 从左到右。 */
    private static final double[] BAND_FREQUENCIES = {
            31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000
    };
    private static final int BAND_COUNT = BAND_FREQUENCIES.length;
    /** 10 段对数等分 → 每段 1 倍频程带宽。 */
    private static final double BAND_Q = 1.414;
    private static final float MAX_GAIN_DB = 12.0f;
    private static final float FLAT_EPSILON_DB = 0.05f;
    private static final double MAX_NORMALIZATION_DB = 24.0;
    /** 伴奏模式补回低音的转折频率：相位抵消会把中置的贝斯/底鼓一起削掉，低频从这里补回。 */
    private static final double BASS_RESTORE_HZ = 120.0;

    private static final int CENTER_NONE = 0;
    private static final int CENTER_VOCAL = 1;
    private static final int CENTER_ACCOMPANIMENT = 2;

    private volatile Effect effect;
    private volatile String requestedPath;
    private volatile float requestedMix = DEFAULT_MIX;

    /** 每段增益（dB），index 对齐 BAND_FREQUENCIES。 */
    private volatile float[] bandGainsDb = new float[BAND_COUNT];
    /**
     * 预衰减（线性）。10 段峰值滤波串联后很容易冲过 0dBFS，旧实现只有最后一句 clamp，
     * 听感就是"糊、刺"——这是均衡器效果差的直接原因。按最大正增益等量衰减即可留出余量。
     */
    private volatile float preampGain = 1.0f;
    private volatile Biquad[] biquads = Biquad.identityChain(BAND_COUNT);
    private volatile boolean eqActive;
    private volatile float normalizationGain = 1.0f;
    private volatile boolean normalizationActive;
    /** 中置声道处理：人声（保留中置）或伴奏（相位抵消中置）。 */
    private volatile int centerMode = CENTER_NONE;
    private volatile boolean centerActive;
    private volatile Biquad bassRestore = Biquad.identity();

    /**
     * 音效/均衡器/中置参数被主线程改过：音频线程下次 queueInput 时重建状态数组。
     * 主线程绝不自己换 history / filterState / bassState（见类注释的竞态说明）。
     */
    private volatile boolean dspStateDirty;

    private int sampleRate;
    private int channels;
    private float[][] history;
    private int historyPosition;
    /** [channel][band][z1,z2]，转置直接 II 型状态。 */
    private double[][][] filterState;
    /** 每帧的通道临时数组（onConfigure 里分配，音频线程不分配）。 */
    private float[] frameScratch;
    /** 伴奏模式低音补回的滤波状态：中置是单声道，单一状态即可。 */
    private double[] bassState = new double[2];

    @Override
    protected AudioFormat onConfigure(AudioFormat inputFormat)
            throws UnhandledAudioFormatException {
        if (inputFormat.encoding != C.ENCODING_PCM_16BIT) {
            Log.w("EchoDsp", "不支持的编码，DSP 将被跳过: " + inputFormat);
            throw new UnhandledAudioFormatException(inputFormat);
        }
        sampleRate = inputFormat.sampleRate;
        channels = inputFormat.channelCount;
        // 证明本处理器确实进了 Media3 音频链（没进链的话均衡器就是空转）。
        // 排查用：adb logcat -s EchoDsp
        Log.i("EchoDsp", "configured rate=" + sampleRate + " channels=" + channels
                + " eq=" + eqActive + " gainDb=" + getNormalizationGainDb()
                + " center=" + centerModeName());
        frameScratch = new float[Math.max(1, channels)];
        resetHistory();
        resetFilterState();
        // 系数依赖采样率，配置到达后必须按真实采样率重建
        rebuildBiquads();
        Effect current = effect;
        if (current == null || current.sampleRate != sampleRate) {
            // 采样率变化（或音效尚未加载）时按当前采样率重载；
            // onReset 不再丢弃音效，所以常见的切歌路径根本走不到这里。
            effect = loadEffectForConfigure();
        }
        return inputFormat;
    }

    @Override
    public boolean isActive() {
        // 始终把处理器挂进 Media3 音频链，才能在播放过程中动态启用/关闭均衡器与音效；
        // 三项都未启用时 queueInput 走零开销透传。
        return inputAudioFormat != null
                && inputAudioFormat.encoding == C.ENCODING_PCM_16BIT;
    }

    @Override
    public void queueInput(ByteBuffer inputBuffer) {
        int bytes = inputBuffer.remaining();
        if (bytes == 0) return;
        ByteBuffer output = replaceOutputBuffer(bytes).order(ByteOrder.LITTLE_ENDIAN);
        ByteBuffer input = inputBuffer.order(ByteOrder.LITTLE_ENDIAN);

        Effect current = effect;
        final boolean convolutionActive = current != null && current.taps.length > 0 && channels > 0;
        final boolean gainActive = normalizationActive;
        final Biquad[] filters = biquads;
        final boolean eqActive = this.eqActive && channels > 0;
        final int center = centerMode;
        // 中置处理需要左右两声，单声道源无法分离
        final boolean centerActive = this.centerActive && channels >= 2 && center != CENTER_NONE;

        if (!convolutionActive && !gainActive && !eqActive && !centerActive) {
            output.put(input);
            output.flip();
            return;
        }
        if (frameScratch == null || frameScratch.length != channels) {
            frameScratch = new float[Math.max(1, channels)];
        }

        // 主线程只置脏；重建必须落在音频线程，否则与下面的逐帧读取竞态
        // （history 尺寸换小 → history[channel][position] 当场 ArrayIndexOutOfBounds）。
        if (dspStateDirty) {
            dspStateDirty = false;
            resetHistory();
            resetFilterState();
            if (bassState == null || bassState.length != 2) bassState = new double[2];
            else {
                bassState[0] = 0.0;
                bassState[1] = 0.0;
            }
        }

        if (convolutionActive
                && (history == null || history.length != channels
                || history[0].length != current.taps.length)) {
            resetHistory();
        }
        if (eqActive && !filterStateMatches()) {
            resetFilterState();
        }

        final float dry = convolutionActive ? 1.0f - current.mix : 0.0f;
        final float wet = convolutionActive ? current.mix : 0.0f;
        final float gain = gainActive ? normalizationGain : 1.0f;
        final int frames = bytes / (2 * channels);
        for (int frame = 0; frame < frames; frame++) {
            for (int channel = 0; channel < channels; channel++) {
                short raw = input.getShort();
                float sample = raw / 32768.0f;
                if (gainActive) sample *= gain;
                if (eqActive) sample = applyEqualizer(sample * preampGain, channel, filters);
                frameScratch[channel] = sample;
            }
            if (centerActive) applyCenterChannel(frameScratch, center);
            for (int channel = 0; channel < channels; channel++) {
                float sample = frameScratch[channel];
                float value = sample;
                if (convolutionActive) {
                    history[channel][historyPosition] = sample;
                    float convolved = 0.0f;
                    int position = historyPosition;
                    for (float tap : current.taps) {
                        convolved += tap * history[channel][position];
                        if (--position < 0) position = current.taps.length - 1;
                    }
                    value = sample * dry + convolved * wet;
                }
                value = softClip(value);
                output.putShort((short) Math.round(value * 32767.0f));
            }
            if (convolutionActive) {
                if (++historyPosition >= current.taps.length) historyPosition = 0;
            }
        }
        output.flip();
    }

    /**
     * 中置声道处理（需立体声）：
     *
     * 人声：主唱通常混在中置，取 mid=(L+R)/2 并回写两声道，人声明显突出。
     * 伴奏：取 side=(L-R)/2 相位抵消，落在中置的人声被抵消；
     *      但贝斯/底鼓往往也在中置，会被一起削掉，所以把 mid 的低频补回来。
     *
     * 两者都是算法近似，不是上游那种重录版本 —— 效果有限，但确实听得出来。
     */
    /**
     * 软限幅（soft clip）。
     *
     * 旧实现是裸的 `min(1,max(-1,x))`：一旦过载就是硬切，产生大量奇次谐波，
     * 听感是"刺、炸"。这里在 0.8 之后用一个廉价的有理曲线压限
     * （x/(1+x) 近似 tanh，比 Math.tanh 便宜得多，可以放在音频线程里），
     * 过载时只是逐渐变平，不会突然出现刺耳谐波。
     */
    private static float softClip(float value) {
        final float threshold = 0.8f;
        float magnitude = Math.abs(value);
        if (magnitude <= threshold) return value;
        float over = (magnitude - threshold) / (1.0f - threshold);
        float limited = threshold + (1.0f - threshold) * (over / (1.0f + over));
        if (limited > 1.0f) limited = 1.0f;
        return value < 0 ? -limited : limited;
    }

    private void applyCenterChannel(float[] frame, int center) {
        float left = frame[0];
        float right = frame[1];
        if (center == CENTER_VOCAL) {
            float mid = (left + right) * 0.5f;
            frame[0] = mid;
            frame[1] = mid;
            return;
        }
        float side = (left - right) * 0.5f;
        float lowMid = (float) bassRestore.process((left + right) * 0.5f, bassState);
        frame[0] = side + lowMid;
        frame[1] = -side + lowMid;
    }

    /** 设置中置处理模式："vocal" / "accompaniment"，其它值视为关闭。 */
    public synchronized void setCenterChannel(String mode) {
        String normalized = mode == null ? "" : mode.trim().toLowerCase();
        int next = "vocal".equals(normalized)
                ? CENTER_VOCAL
                : "accompaniment".equals(normalized) ? CENTER_ACCOMPANIMENT : CENTER_NONE;
        centerMode = next;
        centerActive = next != CENTER_NONE;
        // 低音补回的状态重置交给音频线程（跨线程换数组会与 applyCenterChannel 竞态）
        dspStateDirty = true;
    }

    public String centerModeName() {
        int mode = centerMode;
        return mode == CENTER_VOCAL ? "vocal"
                : mode == CENTER_ACCOMPANIMENT ? "accompaniment" : "none";
    }

    /** 逐段串联峰值滤波（转置直接 II 型），每声道独立状态。 */
    private float applyEqualizer(float sample, int channel, Biquad[] filters) {
        double value = sample;
        for (int band = 0; band < filters.length; band++) {
            Biquad filter = filters[band];
            if (filter.identity) continue;
            double[] bandState = filterState[channel][band];
            double input = value;
            double output = filter.b0 * input + bandState[0];
            bandState[0] = filter.b1 * input - filter.a1 * output + bandState[1];
            bandState[1] = filter.b2 * input - filter.a2 * output;
            value = output;
        }
        // 级联后若溢出成 NaN/Inf，清状态并退回干声，避免把噪声灌满整个后续缓冲
        if (!Double.isFinite(value)) {
            resetFilterState();
            return sample;
        }
        return (float) value;
    }

    @Override
    protected void onFlush() {
        resetHistory();
        resetFilterState();
        bassState = new double[2];
    }

    @Override
    protected void onReset() {
        // ⚠️ 不能清 effect / requestedPath：ExoPlayer 每次 stop()（= 每次切歌、切音质、
        // 无缝换源失败重试）都会 reset 处理器链，而渲染层只在设置变更时下发音效。
        // 这里一清，用户选的卷积音效切歌后静默失效，且没有任何地方会重新加载。
        // 采样率变化由 onConfigure 负责按 requestedPath 重载。
        history = null;
        historyPosition = 0;
        filterState = null;
        frameScratch = null;
        if (bassState == null || bassState.length != 2) bassState = new double[2];
        else Arrays.fill(bassState, 0.0);
        // 均衡器/增益/中置处理是用户设置，不随播放器重置清空
    }

    /**
     * 清空卷积历史。
     *
     * ⚠️ 只在**尺寸变化**时新建数组：`setEqualizer` 每拖一下都会置 dspStateDirty，
     * 而 history 在卷积音效开启时是 channels×taps（最大 2×4096 ≈ 32KB），
     * 每次改动都 new 会让音频线程频繁 GC（爆音/underrun）。尺寸没变就 fill 0。
     */
    private void resetHistory() {
        Effect current = effect;
        int taps = current == null ? 1 : Math.max(1, current.taps.length);
        int channelCount = Math.max(1, channels);
        float[][] existing = history;
        if (existing == null || existing.length != channelCount
                || existing[0] == null || existing[0].length != taps) {
            existing = new float[channelCount][taps];
            history = existing;
        } else {
            for (float[] row : existing) {
                if (row != null) Arrays.fill(row, 0f);
            }
        }
        historyPosition = 0;
    }

    private boolean filterStateMatches() {
        return filterState != null
                && filterState.length == channels
                && filterState[0] != null
                && filterState[0].length == BAND_COUNT;
    }

    private void resetFilterState() {
        int channelCount = Math.max(1, channels);
        double[][][] existing = filterState;
        if (existing == null || existing.length != channelCount
                || existing[0] == null || existing[0].length != BAND_COUNT
                || existing[0][0] == null || existing[0][0].length != 2) {
            filterState = new double[channelCount][BAND_COUNT][2];
            return;
        }
        for (double[][] bands : existing) {
            if (bands == null) continue;
            for (double[] pair : bands) {
                if (pair != null) Arrays.fill(pair, 0.0);
            }
        }
    }

    /**
     * 按当前采样率加载卷积音效。
     *
     * ⚠️ 这里跑在播放线程上（onConfigure），**必须**自己兜住异常：IRS 文件被
     * `deleteAudioResource` 删掉、缓存被系统清理、下载中断留下半截文件，都会让
     * `Effect.load` 抛 IllegalArgumentException。异常一旦逃出 onConfigure，
     * 播放器直接进 onPlayerError —— 而且 `requestedPath` 还留着，于是**每首歌**
     * 起播都失败一次，用户只能手动关音效才能恢复。
     */
    private Effect loadEffectForConfigure() {
        String path = requestedPath;
        if (path == null || path.trim().isEmpty()) return null;
        try {
            return Effect.load(path, sampleRate, requestedMix);
        } catch (Throwable error) {
            Log.w("EchoDsp", "音效加载失败，本次降级为原声: " + path, error);
            requestedPath = null;
            return null;
        }
    }

    private void rebuildBiquads() {
        final int rate = sampleRate > 0 ? sampleRate : 44100;
        final float[] gains = bandGainsDb;
        Biquad[] next = new Biquad[BAND_COUNT];
        for (int band = 0; band < BAND_COUNT; band++) {
            next[band] = Biquad.peaking(BAND_FREQUENCIES[band], BAND_Q, gains[band], rate);
        }
        biquads = next;
        bassRestore = Biquad.lowPass(BASS_RESTORE_HZ, 0.707, rate);
    }

    /** 设置 10 段增益（dB），越界自动 clamp 到 ±12dB。 */
    public synchronized void setEqualizer(float[] gains) {
        float[] next = new float[BAND_COUNT];
        boolean active = false;
        for (int band = 0; band < BAND_COUNT; band++) {
            float value = gains != null && band < gains.length && Float.isFinite(gains[band])
                    ? gains[band]
                    : 0.0f;
            value = Math.max(-MAX_GAIN_DB, Math.min(MAX_GAIN_DB, value));
            next[band] = value;
            if (Math.abs(value) >= FLAT_EPSILON_DB) active = true;
        }
        bandGainsDb = next;
        eqActive = active;
        preampGain = computePreamp(next);
        rebuildBiquads();
        // 滤波器状态重置交给音频线程（跨线程换 filterState 会与 applyEqualizer 竞态）
        dspStateDirty = true;
    }

    /** 预衰减：max(增益) > 0 时整体降这么多 dB。 */
    private static float computePreamp(float[] gains) {
        float maxGainDb = 0.0f;
        for (float gain : gains) {
            if (gain > maxGainDb) maxGainDb = gain;
        }
        if (maxGainDb <= FLAT_EPSILON_DB) return 1.0f;
        return (float) Math.pow(10.0, -maxGainDb / 20.0);
    }

    public float[] getEqualizerGainsDb() {
        return bandGainsDb.clone();
    }

    /** 设置响度归一化增益（dB），由渲染层的 EBU R128 结果给出。 */
    public synchronized void setNormalizationGain(double gainDb) {
        double clamped = Double.isFinite(gainDb)
                ? Math.max(-MAX_NORMALIZATION_DB, Math.min(MAX_NORMALIZATION_DB, gainDb))
                : 0.0;
        normalizationGain = (float) Math.pow(10.0, clamped / 20.0);
        normalizationActive = Math.abs(normalizationGain - 1.0f) > 1e-4f;
    }

    public double getNormalizationGainDb() {
        return normalizationActive ? 20.0 * Math.log10(normalizationGain) : 0.0;
    }

    public synchronized CompletableFuture<Void> setEffect(String path, float mix) {
        requestedPath = path;
        requestedMix = Math.max(0.0f, Math.min(1.0f, mix));
        if (path == null || path.trim().isEmpty()) {
            effect = null;
            dspStateDirty = true;
            return CompletableFuture.completedFuture(null);
        }
        final int targetRate = sampleRate > 0 ? sampleRate : 44100;
        return CompletableFuture.supplyAsync(() -> Effect.load(path, targetRate, requestedMix))
                .thenAccept(loaded -> {
                    if (path.equals(requestedPath)) {
                        effect = loaded;
                        // 本回调跑在加载池线程：只置脏，history 重建由音频线程做。
                        // （旧实现在这里直接 resetHistory()，换小尺寸时会与 queueInput
                        // 的逐帧读取竞态并当场越界。）
                        dspStateDirty = true;
                    }
                });
    }

    public String getEffectPath() {
        return requestedPath;
    }

    /**
     * 峰值（peaking）二阶滤波器。identity=true 表示该段增益为 0，可直接跳过。
     */
    private static final class Biquad {
        final float b0;
        final float b1;
        final float b2;
        final float a1;
        final float a2;
        final boolean identity;

        private Biquad(float b0, float b1, float b2, float a1, float a2, boolean identity) {
            this.b0 = b0;
            this.b1 = b1;
            this.b2 = b2;
            this.a1 = a1;
            this.a2 = a2;
            this.identity = identity;
        }

        static Biquad identity() {
            return new Biquad(1.0f, 0.0f, 0.0f, 0.0f, 0.0f, true);
        }

        static Biquad[] identityChain(int count) {
            Biquad[] chain = new Biquad[count];
            for (int i = 0; i < count; i++) chain[i] = identity();
            return chain;
        }

        static Biquad peaking(double frequency, double q, double gainDb, int sampleRate) {
            if (Math.abs(gainDb) < FLAT_EPSILON_DB || frequency <= 0 || sampleRate <= 0) {
                return identity();
            }
            // 奈奎斯特之上没有可滤波的内容，避免系数算出 NaN
            if (frequency >= sampleRate / 2.0) return identity();
            double a = Math.pow(10.0, gainDb / 40.0);
            double omega = 2.0 * Math.PI * frequency / sampleRate;
            double alpha = Math.sin(omega) / (2.0 * q);
            double cosOmega = Math.cos(omega);
            double b0 = 1.0 + alpha * a;
            double b1 = -2.0 * cosOmega;
            double b2 = 1.0 - alpha * a;
            double a0 = 1.0 + alpha / a;
            double a1 = -2.0 * cosOmega;
            double a2 = 1.0 - alpha / a;
            return new Biquad(
                    (float) (b0 / a0),
                    (float) (b1 / a0),
                    (float) (b2 / a0),
                    (float) (a1 / a0),
                    (float) (a2 / a0),
                    false);
        }

        /** 二阶低通（Butterworth，伴奏模式补回低频用）。参数非法时退化为透传。 */
        static Biquad lowPass(double frequency, double q, int sampleRate) {
            if (frequency <= 0 || sampleRate <= 0 || frequency >= sampleRate / 2.0) return identity();
            double omega = 2.0 * Math.PI * frequency / sampleRate;
            double alpha = Math.sin(omega) / (2.0 * q);
            double cosOmega = Math.cos(omega);
            double b0 = (1.0 - cosOmega) / 2.0;
            double b1 = 1.0 - cosOmega;
            double b2 = (1.0 - cosOmega) / 2.0;
            double a0 = 1.0 + alpha;
            double a1 = -2.0 * cosOmega;
            double a2 = 1.0 - alpha;
            return new Biquad(
                    (float) (b0 / a0),
                    (float) (b1 / a0),
                    (float) (b2 / a0),
                    (float) (a1 / a0),
                    (float) (a2 / a0),
                    false);
        }

        /** 转置直接 II 型单样本递推，state 为 [z1,z2]。 */
        double process(double input, double[] state) {
            if (identity) return input;
            double output = b0 * input + state[0];
            state[0] = b1 * input - a1 * output + state[1];
            state[1] = b2 * input - a2 * output;
            return output;
        }
    }

    public static final class Effect {
        final String path;
        final int sampleRate;
        final float[] taps;
        final float mix;

        private Effect(String path, int sampleRate, float[] taps, float mix) {
            this.path = path;
            this.sampleRate = sampleRate;
            this.taps = taps;
            this.mix = mix;
        }

        static Effect load(String path, int targetRate, float mix) {
            try {
                WavData wav = WavData.read(new File(path));
                float[] taps = resampleAndTrim(wav.samples, wav.sampleRate, targetRate);
                normalize(taps);
                return new Effect(path, targetRate, taps, mix);
            } catch (IOException error) {
                throw new IllegalArgumentException("音效 WAV/IRS 读取失败: " + error.getMessage(), error);
            }
        }

        private static float[] resampleAndTrim(float[] source, int sourceRate, int targetRate) {
            if (source.length == 0) return source;
            int outputLength = Math.min(MAX_TAPS,
                    Math.max(1, Math.round(source.length * (targetRate / (float) sourceRate))));
            float[] output = new float[outputLength];
            for (int i = 0; i < outputLength; i++) {
                float sourceIndex = i * (sourceRate / (float) targetRate);
                int left = Math.min(source.length - 1, (int) sourceIndex);
                int right = Math.min(source.length - 1, left + 1);
                float ratio = sourceIndex - left;
                output[i] = source[left] * (1.0f - ratio) + source[right] * ratio;
            }
            return output;
        }

        /** 按能量归一化（不是"峰值>1 才除"）：湿声响度才有可预期的一致性。 */
        private static void normalize(float[] values) {
            double energy = 0.0;
            for (float value : values) energy += (double) value * value;
            if (energy <= 1e-9) return;
            double gain = 1.0 / Math.sqrt(energy);
            gain = Math.max(0.05, Math.min(20.0, gain));
            float scale = (float) gain;
            for (int i = 0; i < values.length; i++) values[i] *= scale;
        }
    }

    private static final class WavData {
        final int sampleRate;
        final float[] samples;

        private WavData(int sampleRate, float[] samples) {
            this.sampleRate = sampleRate;
            this.samples = samples;
        }

        static WavData read(File file) throws IOException {
            byte[] bytes;
            try (FileInputStream input = new FileInputStream(file)) {
                ByteArrayOutputStream output = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) >= 0) output.write(buffer, 0, count);
                bytes = output.toByteArray();
            }
            if (bytes.length < 44 || !ascii(bytes, 0, "RIFF") || !ascii(bytes, 8, "WAVE")) {
                throw new IOException("不是 RIFF/WAVE 文件");
            }
            int cursor = 12;
            int format = 0;
            int channels = 0;
            int sampleRate = 0;
            int bits = 0;
            int dataOffset = -1;
            int dataLength = 0;
            while (cursor + 8 <= bytes.length) {
                String chunk = new String(bytes, cursor, 4, java.nio.charset.StandardCharsets.US_ASCII);
                int length = leInt(bytes, cursor + 4);
                int start = cursor + 8;
                if (length < 0 || start > bytes.length) break;
                int end = Math.min(bytes.length, start + length);
                if ("fmt ".equals(chunk) && end - start >= 16) {
                    format = leShort(bytes, start);
                    channels = leShort(bytes, start + 2);
                    sampleRate = leInt(bytes, start + 4);
                    bits = leShort(bytes, start + 14);
                } else if ("data".equals(chunk)) {
                    dataOffset = start;
                    dataLength = end - start;
                }
                cursor = start + length + (length & 1);
            }
            if (dataOffset < 0 || sampleRate <= 0 || channels <= 0 || (format != 1 && format != 3)) {
                throw new IOException("WAV 格式不支持");
            }
            int bytesPerSample = bits / 8;
            if (bytesPerSample != 2 && !(format == 3 && bytesPerSample == 4)) {
                throw new IOException("仅支持 PCM16/Float32 WAV");
            }
            int frameBytes = bytesPerSample * channels;
            int frames = dataLength / frameBytes;
            float[] samples = new float[frames];
            ByteBuffer data = ByteBuffer.wrap(bytes, dataOffset, dataLength).order(ByteOrder.LITTLE_ENDIAN);
            for (int frame = 0; frame < frames; frame++) {
                float sum = 0.0f;
                for (int channel = 0; channel < channels; channel++) {
                    sum += format == 3 ? data.getFloat() : data.getShort() / 32768.0f;
                }
                samples[frame] = sum / channels;
            }
            return new WavData(sampleRate, samples);
        }

        private static boolean ascii(byte[] bytes, int offset, String value) {
            if (offset + value.length() > bytes.length) return false;
            for (int i = 0; i < value.length(); i++) if (bytes[offset + i] != value.charAt(i)) return false;
            return true;
        }

        private static int leShort(byte[] bytes, int offset) {
            return (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8);
        }

        private static int leInt(byte[] bytes, int offset) {
            return (bytes[offset] & 0xff) | ((bytes[offset + 1] & 0xff) << 8)
                    | ((bytes[offset + 2] & 0xff) << 16) | ((bytes[offset + 3] & 0xff) << 24);
        }
    }
}
