"use client";

import { useEffect, useRef, useState } from "react";
import { LayerCard, Loader, Text } from "@cloudflare/kumo";
import { paintOverview } from "../lib/paint";
import { Player } from "./components/player";

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

// s as m:ss.
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  return `${minutes}:${remain.toString().padStart(2, "0")}`;
}

export default function Home() {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef(null);
  const peaksRef = useRef(null);
  const timeRef = useRef(null);
  const overviewRef = useRef(null);
  const seekSyncRef = useRef(null);
  const scrubbingRef = useRef(false);
  const wasPlayingRef = useRef(false);

  useEffect(() => {
    let dead = false;
    let context = null;
    let objectUrl = null;
    void (async () => {
      try {
        const { data, bytes } = await loadFlac();
        if (dead) return;
        context = new AudioContext();
        const decoded = await context.decodeAudioData(data.slice(0));
        if (dead) return;
        peaksRef.current = computePeaks(decoded, 700);
        objectUrl = URL.createObjectURL(new Blob([data], { type: "audio/flac" }));
        const audio = new Audio(objectUrl);
        audio.onended = () => setPlaying(false);
        audioRef.current = audio;
        setMeta({ duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, flacBytes: bytes });
      } catch (caught) {
        if (!dead) setError(caught instanceof Error ? caught.message : "Could not start the audio.");
      } finally {
        if (context) void context.close();
      }
    })();
    return () => {
      dead = true;
      audioRef.current?.pause();
      audioRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  useEffect(() => {
    if (!meta) return;
    let frame = 0;
    const loop = () => {
      const position = audioRef.current?.currentTime || 0;
      if (timeRef.current) timeRef.current.textContent = formatTime(position);
      if (!scrubbingRef.current) seekSyncRef.current?.(position);
      const peaks = peaksRef.current;
      if (peaks && overviewRef.current) paintOverview(overviewRef.current, peaks.mins, peaks.maxs, position, meta.duration);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [meta]);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      void audio.play().then(() => setPlaying(true)).catch((caught) => setError(caught.message));
    } else {
      audio.pause();
      setPlaying(false);
    }
  }

  function seek(time) {
    if (audioRef.current) audioRef.current.currentTime = time;
  }

  function beginScrub() {
    const audio = audioRef.current;
    scrubbingRef.current = true;
    wasPlayingRef.current = !!audio && !audio.paused;
    if (audio) audio.pause();
    setPlaying(false);
  }

  function endScrub() {
    scrubbingRef.current = false;
    if (wasPlayingRef.current) toggle();
  }

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
        {meta && <Player meta={meta} playing={playing} onToggle={toggle} timeRef={timeRef} overviewRef={overviewRef} seekSyncRef={seekSyncRef} scrubbingRef={scrubbingRef} onSeek={seek} onScrubStart={beginScrub} onScrubEnd={endScrub} formatTime={formatTime} />}
            <div className="steps">
              <LayerCard className="step"><Text>turn the original data into segments (1024 samples)</Text></LayerCard>
              <LayerCard className="step"><Text>transform each segment into the frequencies it contains</Text></LayerCard>
              <LayerCard className="step"><Text>discard frequencies listeners cannot hear: either too quiet or drowned out by larger freqs (this is called masking)</Text></LayerCard>
              <LayerCard className="step"><Text>hear the lossily compressed audio as you change the parameters</Text></LayerCard>
            </div>
      </div>
    </main>
  );
}
