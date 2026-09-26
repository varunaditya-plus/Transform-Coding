"use client";

import { useEffect, useState } from "react";
import { LayerCard, Loader, Text } from "@cloudflare/kumo";

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

  useEffect(() => {
    let dead = false;
    let context = null;
    void (async () => {
      try {
        const { data, bytes } = await loadFlac();
        if (dead) return;
        context = new AudioContext();
        const decoded = await context.decodeAudioData(data.slice(0));
        if (dead) return;
        setMeta({ duration: decoded.duration, sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels, flacBytes: bytes });
      } catch (caught) {
        if (!dead) setError(caught instanceof Error ? caught.message : "Could not load the audio.");
      } finally {
        if (context) void context.close();
      }
    })();
    return () => { dead = true; };
  }, []);

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
        {meta && (
          <LayerCard className="step">
            <Text>Loaded {formatTime(meta.duration)} of audio at {meta.sampleRate} Hz across {meta.channels} channel(s). The FLAC file is {(meta.flacBytes / 1_000_000).toFixed(1)} MB.</Text>
          </LayerCard>
        )}
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
