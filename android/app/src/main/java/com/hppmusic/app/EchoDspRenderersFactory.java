package com.hppmusic.app;

import android.content.Context;

import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.audio.AudioSink;
import androidx.media3.exoplayer.audio.DefaultAudioSink;

/** Injects the mobile convolution processor into Media3's PCM audio sink. */
public final class EchoDspRenderersFactory extends DefaultRenderersFactory {
    private final EchoDspAudioProcessor processor;

    public EchoDspRenderersFactory(Context context, EchoDspAudioProcessor processor) {
        super(context);
        this.processor = processor;
        setEnableAudioFloatOutput(false);
    }

    @Override
    protected AudioSink buildAudioSink(
            Context context,
            boolean enableFloatOutput,
            boolean enableAudioTrackPlaybackParams) {
        return new DefaultAudioSink.Builder(context)
                .setEnableFloatOutput(false)
                .setEnableAudioTrackPlaybackParams(enableAudioTrackPlaybackParams)
                .setAudioProcessors(new AudioProcessor[]{processor})
                .build();
    }
}
