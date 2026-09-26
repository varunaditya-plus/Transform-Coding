"use client";

import { useEffect, useRef, useState } from "react";
import { Button, LayerCard, Loader, Text, Link } from "@cloudflare/kumo";
import { MoonIcon, SunIcon } from "@phosphor-icons/react";
import { analyseFrame, compress, createCoder } from "../lib/transform-coding";
import { paintOverview, paintSegment, paintSpectrum, resetColors } from "../lib/paint";
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
  if (engine.streaming) {
    const rate = engine.original.sampleRate;
    const ahead = engine.queueEndTime - engine.ctx.currentTime;
    const seconds = (engine.queueEndSample - ahead * rate) / rate;
    return Math.min(engine.original.duration, Math.max(0, seconds));
  }
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
  const [mode, setMode] = useState("dark");
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

  // The sound is coded a hop ahead of the playhead, so slider moves are heard on the next segment. This full pass only updates the size numbers.
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
      if (engine.playing && engine.playMode !== "original") {
        engine.offset = enginePosition(engine);
        playRef.current();
      }
      return;
    }

    if (engine.playing && (engine.playMode !== "stream" || engine.coderSize !== settings.fftSize)) {
      engine.offset = enginePosition(engine);
      playRef.current();
    } else if (engine.coder && engine.coderSize === settings.fftSize) {
      engine.coder.setParams(toParams(settings));
    }

    const key = settingsKey(settings);
    if (engine.compressedKey === key) {
      setBusy(false);
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
          engine.compressedKey = key;
          setKeptShare(result.stats.kept / result.stats.bins);
          setBusy(false);
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
        if (engine.streaming) {
          pump(engine);
          if (engine.queueEndSample >= engine.original.length && engine.queueEndTime <= engine.ctx.currentTime) {
            engine.offset = 0;
            halt();
            setPlaying(false);
          }
        }
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

  // Stop whatever is currently sounding.
  function halt() {
    const engine = engineRef.current;
    if (!engine) return;
    engine.token += 1;
    engine.playing = false;
    engine.streaming = false;
    const source = engine.source;
    engine.source = null;
    const queue = engine.queue;
    engine.queue = [];
    if (source) {
      try { source.stop(); } catch {}
    }
    if (queue) {
      for (let i = 0; i < queue.length; i++) {
        try { queue[i].stop(); } catch {}
      }
    }
  }

  // Keep a short queue of coded hops so playback never waits on the rest of the file.
  function pump(engine) {
    if (!engine.streaming || !engine.playing || !engine.coder) return;
    const rate = engine.original.sampleRate;
    const hop = engine.coderSize >> 1;
    const hopSeconds = hop / rate;
    const ahead = Math.min(0.08, Math.max(hopSeconds * 2, 0.03));
    const ctx = engine.ctx;
    let guard = 0;
    while (engine.queueEndTime < ctx.currentTime + ahead && guard++ < 8) {
      if (engine.coder.finished || engine.queueEndSample >= engine.original.length) break;
      const count = hop;
      const data = engine.coder.read(count);
      if (!data) break;
      const blockStart = engine.coder.position - count;
      let start = 0;
      if (engine.skip) {
        start = Math.min(engine.skip, count);
        engine.skip -= start;
      }
      let end = count;
      if (blockStart + end > engine.original.length) end = Math.max(start, engine.original.length - blockStart);
      const usable = end - start;
      engine.queueEndSample = blockStart + end;
      if (usable <= 0) break;
      const sliced = [];
      for (let c = 0; c < data.length; c++) sliced.push(data[c].subarray(start, end));
      const buffer = makeBuffer(ctx, sliced, rate);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(engine.gain);
      let when = engine.queueEndTime;
      if (when < ctx.currentTime) when = ctx.currentTime;
      src.start(when);
      const token = engine.token;
      src.onended = () => {
        if (engine.token !== token) return;
        const index = engine.queue.indexOf(src);
        if (index >= 0) engine.queue.splice(index, 1);
      };
      engine.queue.push(src);
      engine.queueEndTime = when + buffer.duration;
    }
  }

  function playOriginal(engine) {
    const buffer = engine.original;
    if (engine.offset >= buffer.duration - 0.05) engine.offset = 0;
    const source = engine.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(engine.gain);
    source.start(0, engine.offset);
    engine.startedAt = engine.ctx.currentTime;
    engine.source = source;
    engine.streaming = false;
    engine.playMode = "original";
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

  // Play from engine.offset. Compressed playback is coded on the way out.
  function start() {
    const engine = engineRef.current;
    if (!engine) return;
    const settings = settingsRef.current;
    let offset = engine.offset;
    if (offset >= engine.original.duration - 0.05) offset = 0;
    void engine.ctx.resume();
    halt();
    engine.offset = offset;
    resumeRef.current = false;
    if (settings.bypass) {
      playOriginal(engine);
      return;
    }
    const original = engine.original;
    const channels = [];
    for (let c = 0; c < original.numberOfChannels; c++) channels.push(original.getChannelData(c));
    if (!engine.coder || engine.coderSize !== settings.fftSize) {
      engine.coder = createCoder(settings.fftSize, original.sampleRate);
      engine.coderSize = settings.fftSize;
    }
    engine.coder.setSource(channels);
    engine.coder.setParams(toParams(settings));
    let sample = Math.floor(offset * original.sampleRate);
    if (sample >= original.length) sample = 0;
    const aligned = engine.coder.seek(sample);
    engine.queue = [];
    engine.skip = sample - aligned;
    engine.queueEndSample = aligned;
    engine.queueEndTime = engine.ctx.currentTime;
    engine.streaming = true;
    engine.playMode = "stream";
    engine.playing = true;
    pump(engine);
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

  function toggleMode() {
    const next = mode === "dark" ? "light" : "dark";
    setMode(next);
    document.documentElement.dataset.mode = next;
    document.documentElement.style.colorScheme = next;
    resetColors();
  }

  async function upload(file) {
    const engine = engineRef.current;
    if (!engine || !file) return;
    jobRef.current += 1;
    halt();
    setPlaying(false);
    resumeRef.current = false;
    setError(null);
    setBusy(true);
    try {
      const data = await file.arrayBuffer();
      const audioBuffer = await engine.ctx.decodeAudioData(data.slice(0));
      if (engineRef.current !== engine) return;
      engine.original = audioBuffer;
      engine.coder = null;
      engine.coderSize = 0;
      engine.compressedKey = "";
      engine.offset = 0;
      peaksRef.current = computePeaks(audioBuffer, 700);
      const initial = readFrame(audioBuffer, 0, settingsRef.current);
      shownRef.current = initial;
      setDisplay(initial.stats);
      if (timeRef.current) timeRef.current.textContent = formatTime(0);
      seekSyncRef.current?.(0);
      const channels = audioBuffer.numberOfChannels;
      setMeta({ duration: audioBuffer.duration, sampleRate: audioBuffer.sampleRate, channels, pcmBytes: audioBuffer.length * channels * 2, flacBytes: file.size, sourceLabel: file.name });
    } catch {
      if (engineRef.current !== engine) return;
      setBusy(false);
      setError("Could not read that audio file.");
    }
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
  const audioLength = meta ? meta.duration * 1000 : 0;

  return (
    <main className="page">
      <div className="stack">
        <div className="lede">
          <div className="title-row">
            <Text as="h1" variant="heading" size="lg">Transform coding</Text>
            <Button type="button" shape="circle" variant="secondary" onClick={toggleMode}>{mode === "dark" ? <SunIcon /> : <MoonIcon />}</Button>
          </div>
          <Text variant="secondary">Transform coding is where data is turned into a different representation (depending on the kind of file), and then different methods are used to reduce file size. This demo shows how transform coding works in audio files. First, the encoder turns the audio into short segments, and transforms the frequencies each segment contains. It them removes frequencies the listener cannot hear (frequencies too quiet or overlapped by other frequencies). This is called masking. Discarding the inaudible content using transform coding is why audio files around 20-30MB can be shrunk to just 2-3, while sounding nearly identical.</Text>
          <Text variant="secondary">The transform this app uses is just a fast Fourier transform from the FFT.js library (not really relevant for IB syllabus). These controls are the lossy step: what gets thrown away. If nothing gets discarded, the sound will matches the original sample.</Text>
          <Text variant="secondary">This demo uses a lossless FLAC file of the song "Miracle Aligner" by The Last Shadow Puppets to show the true extent of the compression, but you can upload your own audio file (any format) to see how it works. You can find high quality .FLACs on <Link href="https://monochrome.st/" target="_blank">Monochrome.st</Link>. I'd recommend using a FLAC as they are lossless and results will be cooler.</Text>
        </div>

        {error && <Text variant="error">{error}</Text>}

        {!meta && !error && <Loader size="lg" />}

        {meta && display && (
          <>
            <Player meta={meta} playing={playing} busy={busy} bypass={settings.bypass} onPatch={patch} onToggle={toggle} onUpload={upload} timeRef={timeRef} overviewRef={overviewRef} seekSyncRef={seekSyncRef} scrubbingRef={scrubbingRef} onSeek={seek} onScrubStart={beginScrub} onScrubEnd={endScrub} formatTime={formatTime} />
            <div className="steps">
              <LayerCard className="step"><Text>Turn the original data into segments ({settings.fftSize} samples)</Text></LayerCard>
              <LayerCard className="step"><Text>Transform each segment into the frequencies it contains</Text></LayerCard>
              <LayerCard className="step"><Text>Discard frequencies listeners cannot hear: either too quiet or drowned out by larger frequencies (this is called masking)</Text></LayerCard>
              <LayerCard className="step"><Text>Hear the lossily compressed audio as you change the parameters</Text></LayerCard>
            </div>
            <section className="stage">
              <Visuals spectrumRef={spectrumRef} segmentRef={segmentRef} />
              <Controls settings={settings} nyquist={nyquist} cutoff={cutoff} segmentMs={segmentMs} audioLength={audioLength} sampleRate={meta.sampleRate} busy={busy} keptShare={keptShare} estimate={estimate} times={times} flacBytes={meta.flacBytes} pcmBytes={meta.pcmBytes} sourceLabel={meta.sourceLabel} onPatch={patch} formatHz={formatHz}/>
            </section>
          </>
        )}
      </div>
    </main>
  );
}
