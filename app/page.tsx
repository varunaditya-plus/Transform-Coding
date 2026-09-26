"use client";

import { useEffect, useRef, useState } from "react";
import { LayerCard, Loader, Text } from "@cloudflare/kumo";
import { analyseFrame, compress } from "../lib/transform-coding";
import { paintOverview, paintSegment, paintSpectrum } from "../lib/paint";
import { Controls } from "./components/controls";
import { Player } from "./components/player";
import { Visuals } from "./components/visuals";

// Initial settings. Probably should be a state variable, but wtv.
const INITIAL = {
  fftSize: 1024,
  cutoffHz: 5000,
  quiet: 0.04,
  mask: 0.12,
  bypass: false,
};

let flacPromise = null;
let flacProgress = 0;
const flacListeners = [];

// Remember the latest download ratio
function emitFlacProgress(ratio) {
  flacProgress = ratio;
  for (const listener of flacListeners) listener(ratio);
}

// Return the downloading or finished download. Failed fetch clears the promise so the next call tries again.
function loadFlac() {
  if (!flacPromise) {
    flacPromise = readFlac(emitFlacProgress).catch((error) => {
      flacPromise = null;
      throw error;
    });
  }
  return flacPromise;
}

// Stream the FLAC so progress can be reported, then join the chunks into a buffer. (for ref: https://developer.mozilla.org/en-US/docs/Web/API/Streams_API/Using_readable_streams)
async function readFlac(onProgress) {
  const response = await fetch("/song.flac");
  if (!response.ok || !response.body) {
    throw new Error("Could not load the recording.");
  }
  const total = Number(response.headers.get("content-length") || 0);
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0) onProgress(received / total);
  }
  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onProgress(1);
  return { data: data.buffer, bytes: received };
}

function toParams(settings) {
  return { cutoffHz: settings.cutoffHz, quiet: settings.quiet, mask: settings.mask, bypass: settings.bypass };
}

function readFrame(buffer, position, settings) {
  const n = settings.fftSize;
  const hop = n >> 1;
  let start = Math.floor(position * buffer.sampleRate);
  start = Math.max(0, Math.floor(start / hop) * hop);
  if (start + n > buffer.length) start = Math.max(0, buffer.length - n);
  const data = buffer.getChannelData(0);
  const frame = new Float32Array(n);
  for (let i = 0; i < n; i++) frame[i] = data[start + i] ?? 0;
  return analyseFrame(frame, buffer.sampleRate, toParams(settings));
}

// Min and max of each slice of the song, averaged across channels.
function computePeaks(buffer, buckets) {
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const mins = new Float32Array(buckets);
  const maxs = new Float32Array(buckets);
  const block = Math.max(1, Math.floor(buffer.length / buckets));
  for (let i = 0; i < buckets; i++) {
    let min = 0;
    let max = 0;
    const start = i * block;
    const end = Math.min(buffer.length, start + block);
    for (let j = start; j < end; j++) {
      let value = 0;
      for (let c = 0; c < channels.length; c++) value += channels[c][j];
      value /= channels.length;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    mins[i] = min;
    maxs[i] = max;
  }
  return { mins, maxs };
}

function settingsKey(settings) {
  return `${settings.fftSize}|${settings.cutoffHz}|${settings.quiet}|${settings.mask}`;
}

function enginePosition(engine) {
  if (!engine) return 0;
  if (!engine.playing) return engine.offset;
  const time = engine.offset + (engine.ctx.currentTime - engine.startedAt);
  return Math.min(engine.original.duration, Math.max(0, time));
}

// Wrap channel arrays in an AudioBuffer the context can play. getChannelData() returns that buffer's channel, and set() copies into it.
function makeBuffer(ctx, channels, sampleRate) {
  const audio = ctx.createBuffer(channels.length, channels[0].length, sampleRate);
  for (let c = 0; c < channels.length; c++) audio.getChannelData(c).set(channels[c]);
  return audio;
}

// s as m:ss.
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  return `${minutes}:${remain.toString().padStart(2, "0")}`;
}

// Label for the cutoff slider. At Nyquist every frequency is kept, so the label is "All".
// Nyquist is the highest frequency that can be represented in the audio signal.
function formatHz(hz, nyquist) {
  if (hz >= nyquist - 5) return "All";
  if (hz >= 1000) {
    const digits = hz >= 10000 ? 0 : 1;
    return `${(hz / 1000).toFixed(digits)} kHz`;
  }
  return `${Math.round(hz)} Hz`;
}

export default function Home() {
  const [settings, setSettings] = useState(INITIAL);
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [display, setDisplay] = useState(null);
  const [keptShare, setKeptShare] = useState(1); // Share of bins kept by the last full pass. 1 until that pass finishes.
  const [busy, setBusy] = useState(false);

  // The audio graph and playback bookkeeping. Kept off React state so the animation loop can read it without rendering.
  const engineRef = useRef(null);
  const settingsRef = useRef(settings);
  // Last analysed segment the canvases are drawing.
  const shownRef = useRef(null);
  const peaksRef = useRef(null);
  // performance.now() of the last playhead analysis.
  const lastStatRef = useRef(0);
  const scrubbingRef = useRef(false);
  const wasPlayingRef = useRef(false);
  // Play was asked for before the compressed buffer existed.
  const resumeRef = useRef(false);
  // Id of the compress pass in flight. A newer id cancels the older pass.
  const jobRef = useRef(0);
  // Latest start(), so an effect can call it without taking it as a dependency.
  const playRef = useRef(() => {});
  const overviewRef = useRef(null);
  const spectrumRef = useRef(null);
  const segmentRef = useRef(null);
  const timeRef = useRef(null);
  // SeekSlider registers its setter here so the playhead moves without rendering this page.
  const seekSyncRef = useRef(null);
  const controls = useRef({ toggle: () => {}, seek: (_time) => {} });

  // Keep the ref current during render, before effects and the animation loop.
  settingsRef.current = settings;

  // Load the FLAC, decode it, and build the audio graph.
  useEffect(() => {
    let dead = false;
    let ctx = null;

    const fail = (message) => {
      if (!dead) setError(message);
    };

    void (async () => {
      try {
        const { data, bytes } = await loadFlac();
        if (dead) return;
        const probe = new AudioContext();
        // decodeAudioData detaches the ArrayBuffer it is given. slice(0) copies the cached bytes so a second mount can decode them too. (for ref: https://www.w3.org/TR/webaudio/#dom-baseaudiocontext-decodeaudiodata)
        const audioBuffer = await probe.decodeAudioData(data.slice(0));
        if (dead) {
          await probe.close();
          return;
        }
        ctx = probe;
        // A context at the file's rate plays the buffer without resampling.
        if (probe.sampleRate !== audioBuffer.sampleRate) {
          try {
            const matched = new AudioContext({ sampleRate: audioBuffer.sampleRate });
            await probe.close();
            ctx = matched;
          } catch {
            ctx = probe;
          }
        }
        if (dead) {
          await ctx.close();
          return;
        }
        const gain = ctx.createGain();
        gain.gain.value = 1;
        gain.connect(ctx.destination);
        const channels = audioBuffer.numberOfChannels;
        const engine = {
          ctx,
          original: audioBuffer,
          compressed: null,
          compressedKey: "",
          gain,
          source: null,
          offset: 0,
          startedAt: 0,
          playing: false,
          token: 0,
        };
        engineRef.current = engine;
        peaksRef.current = computePeaks(audioBuffer, 700);
        const initial = readFrame(audioBuffer, 0, settingsRef.current);
        shownRef.current = initial;
        setDisplay(initial.stats);
        setBusy(true);
        // 16-bit PCM is two bytes per sample per channel. The AudioBuffer itself stores floats (for ref: https://en.wikipedia.org/wiki/Pulse-code_modulation)
        setMeta({ duration: audioBuffer.duration, sampleRate: audioBuffer.sampleRate, channels, pcmBytes: audioBuffer.length * channels * 2, flacBytes: bytes });
      } catch (caught) {
        fail(caught instanceof Error ? caught.message : "Could not start the audio.");
      }
    })();

    return () => {
      dead = true;
      const engine = engineRef.current;
      engineRef.current = null;
      if (engine) {
        engine.token += 1;
        try {
          engine.source?.stop();
        } catch {}
        void engine.ctx.close();
      } else if (ctx) {
        void ctx.close();
      }
    };
  }, []);

  // Recompress when the lossy settings change. If original samples are playing, js play decoded buffer. The timer waits for the slider to settle, and a newer job id throws away a pass that the settings have already moved past.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !meta) return;
    const snap = readFrame(engine.original, enginePosition(engine), settings);
    shownRef.current = snap;
    setDisplay(snap.stats);

    if (settings.bypass) {
      jobRef.current += 1;
      setBusy(false);
      setKeptShare(1);
      if (engine.playing) {
        engine.offset = enginePosition(engine);
        playRef.current();
      }
      return;
    }

    const key = settingsKey(settings);
    if (engine.compressed && engine.compressedKey === key) {
      setBusy(false);
      if (engine.playing || resumeRef.current) {
        engine.offset = enginePosition(engine);
        playRef.current();
      }
      return;
    }

    const job = ++jobRef.current;
    setBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        if (job !== jobRef.current || engineRef.current !== engine) return;
        const channels = [];
        for (let c = 0; c < engine.original.numberOfChannels; c++) {
          channels.push(engine.original.getChannelData(c));
        }
        try {
          const result = await compress(channels, engine.original.sampleRate, settings.fftSize, toParams(settings), () => job !== jobRef.current || engineRef.current !== engine);
          if (job !== jobRef.current || engineRef.current !== engine || result.stats.bins === 0) return;
          const wasPlaying = engine.playing || resumeRef.current;
          const position = enginePosition(engine);
          engine.compressed = makeBuffer(engine.ctx, result.channels, engine.original.sampleRate);
          engine.compressedKey = key;
          engine.offset = position;
          setKeptShare(result.stats.kept / result.stats.bins);
          setBusy(false);
          if (wasPlaying) playRef.current();
        } catch (caught) {
          if (job !== jobRef.current || engineRef.current !== engine) return;
          setBusy(false);
          setError(caught instanceof Error ? caught.message : "Could not compress the audio.");
        }
      })();
    }, 80);

    return () => window.clearTimeout(timer);
  }, [settings, meta]);

  // Paint the clock and the canvases every frame. The clock is written on the DOM node so this page does not re-render at frame rate.
  useEffect(() => {
    if (!meta) return;
    let frame = 0;
    const loop = () => {
      const engine = engineRef.current;
      const position = enginePosition(engine);
      if (timeRef.current) timeRef.current.textContent = formatTime(position);
      if (!scrubbingRef.current) seekSyncRef.current?.(position);
      const font = getComputedStyle(document.body).fontFamily;
      const peaks = peaksRef.current;
      if (overviewRef.current && peaks) {
        paintOverview(overviewRef.current, peaks.mins, peaks.maxs, position, meta.duration);
      }
      // The spectrum and segment are the original audio at the playhead, so the picture still shows what was discarded. FFT is refreshed every 120ms
      const snap = shownRef.current;
      if (snap && spectrumRef.current) paintSpectrum(spectrumRef.current, snap, Math.min(settingsRef.current.cutoffHz, meta.sampleRate / 2), meta.sampleRate, font);
      if (snap && segmentRef.current) paintSegment(segmentRef.current, snap);
      if (engine?.playing) {
        const now = performance.now();
        if (now - lastStatRef.current > 120) {
          lastStatRef.current = now;
          const next = readFrame(engine.original, position, settingsRef.current);
          shownRef.current = next;
        }
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [meta]);

  // Original samples, or the latest compressed buffer.
  function playbackBuffer(engine) {
    if (settingsRef.current.bypass) return engine.original;
    return engine.compressed;
  }

  // Stop the current source.
  function halt() {
    const engine = engineRef.current;
    if (!engine) return;
    engine.token += 1;
    engine.playing = false;
    const source = engine.source;
    engine.source = null;
    if (!source) return;
    try {
      source.stop();
    } catch {}
  }

  // Play from engine.offset. If the compressed buffer is not ready, start when it is.
  function start() {
    const engine = engineRef.current;
    if (!engine) return;
    const buffer = playbackBuffer(engine);
    if (!buffer) {
      resumeRef.current = true;
      return;
    }
    resumeRef.current = false;
    void engine.ctx.resume();
    halt();

    if (engine.offset >= buffer.duration - 0.05) engine.offset = 0;
    const source = engine.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(engine.gain);

    source.start(0, engine.offset);
    engine.startedAt = engine.ctx.currentTime;
    engine.source = source;
    engine.playing = true;
    const token = engine.token;
    source.onended = () => {
      if (engine.token !== token || engineRef.current !== engine) return;
      engine.playing = false;
      engine.source = null;
      engine.offset = 0;
      setPlaying(false);
    };
    setPlaying(true);
  }

  // Freeze playhead, and stop playback.
  function pause() {
    const engine = engineRef.current;
    if (!engine?.playing) return;
    resumeRef.current = false;
    engine.offset = enginePosition(engine);
    halt();
    setPlaying(false);
  }

  // Pause if audio is playing otherwise start.
  function toggle() {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.playing) pause();
    else start();
  }

  // Move the playhead and refresh the segment picture. Restart source only when audio is already playing and the scrubbing isnt happening
  function seek(time) {
    const engine = engineRef.current;
    if (!engine) return;
    engine.offset = Math.min(Math.max(0, time), engine.original.duration);
    if (timeRef.current) timeRef.current.textContent = formatTime(engine.offset);
    const snap = readFrame(engine.original, engine.offset, settingsRef.current);
    shownRef.current = snap;
    setDisplay(snap.stats);
    if (engine.playing && !scrubbingRef.current) start();
  }

  playRef.current = start;
  controls.current.toggle = toggle;
  controls.current.seek = seek;

  function patch(partial) {
    setSettings((current) => ({ ...current, ...partial }));
  }

  function beginScrub() {
    const engine = engineRef.current;
    wasPlayingRef.current = !!engine?.playing;
    scrubbingRef.current = true;
    if (engine?.playing) pause();
  }

  function endScrub() {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    if (wasPlayingRef.current) start();
  }

  // Nyquist is half the sample rate: the highest frequency in the recording. (for ref: https://en.wikipedia.org/wiki/Nyquist_frequency)
  const nyquist = meta ? meta.sampleRate / 2 : 22050;
  const cutoff = Math.min(settings.cutoffHz, nyquist);
  const estimate = meta ? meta.pcmBytes * keptShare : 0;
  const times = keptShare > 0.001 ? 1 / keptShare : 0;
  const segmentMs = meta ? (settings.fftSize / meta.sampleRate) * 1000 : 0;

  return (
    <main className="page">
      <div className="stack">
        <div className="lede">
          <Text as="h1" variant="heading" size="lg">Transform coding</Text>
          <Text variant="secondary">Transform coding is where data is turned into a different representation (depending on the kind of file), and then different methods are used to reduce file size. This demo shows how transform coding works in audio files. First, the encoder turns the audio into short segments, and transforms the frequencies each segment contains. It them removes frequencies the listener cannot hear (frequencies too quiet or overlapped by other frequencies). This is called masking. Discarding the inaudible content using transform coding is why audio files around 20-30MB can be shrunk to just 2-3, while sounding nearly identical.</Text>
          <Text variant="secondary">The transform itself is a fast Fourier transform from a JS library (not really relevant for IB syllabus). These controls are the lossy step: what gets thrown away. If nothing gets discarded, the sound will matches the original sample. This demo uses a lossless FLAC file of the song "Miracle Aligner" by The Last Shadow Puppets to show the true extent of the compression.</Text>
        </div>

        {error && <Text variant="error">{error}</Text>}

        {!meta && !error && <Loader size="lg" />}

        {meta && display && (
          <>
            <Player meta={meta} playing={playing} busy={busy} bypass={settings.bypass} onPatch={patch} onToggle={toggle} timeRef={timeRef} overviewRef={overviewRef} seekSyncRef={seekSyncRef} scrubbingRef={scrubbingRef} onSeek={seek} onScrubStart={beginScrub} onScrubEnd={endScrub} formatTime={formatTime} />
            <div className="steps">
              <LayerCard className="step"><Text>turn the original data into segments ({settings.fftSize} samples)</Text></LayerCard>
              <LayerCard className="step"><Text>transform each segment into the frequencies it contains</Text></LayerCard>
              <LayerCard className="step"><Text>discard frequencies listeners cannot hear: either too quiet or drowned out by larger freqs (this is called masking)</Text></LayerCard>
              <LayerCard className="step"><Text>hear the lossily compressed audio as you change the parameters</Text></LayerCard>
            </div>
            <section className="stage">
              <Visuals spectrumRef={spectrumRef} segmentRef={segmentRef} />
              <Controls settings={settings} nyquist={nyquist} cutoff={cutoff} segmentMs={segmentMs} sampleRate={meta.sampleRate} busy={busy} keptShare={keptShare} estimate={estimate} times={times} flacBytes={meta.flacBytes} pcmBytes={meta.pcmBytes} onPatch={patch} formatHz={formatHz}/>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
