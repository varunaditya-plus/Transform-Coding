import FFT from "fft.js";

// mostly written using logic from the lamejs encoder + ai

export const KEPT = 0;
export const HIGH = 1;
export const QUIET = 2;
export const MASKED = 3;

const previewPool = new Map();

function workspace(size) {
  if (size < 4 || (size & (size - 1)) !== 0) {
    throw new Error("Segment length must be a power of two.");
  }
  const fft = new FFT(size);
  // Periodic Hann window: 0.5 * (1 - cos(2πi / N)) (for ref: https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.windows.hann.html)
  const window = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return {
    n: size,
    fft,
    window,
    frame: new Float32Array(size),
    windowed: new Float32Array(size),
    timeOut: new Float32Array(size),
    spectrum: fft.createComplexArray(),
    inv: fft.createComplexArray(),
    magnitudes: new Float32Array(size / 2 + 1),
    reasons: new Uint8Array(size / 2 + 1),
  };
}

// Counters for one segment, or for the whole file. bins === 0 means unused.
function emptyStats() {
  return { bins: 0, kept: 0, high: 0, quiet: 0, masked: 0 };
}

function addStats(total, frame) {
  total.bins += frame.bins;
  total.kept += frame.kept;
  total.high += frame.high;
  total.quiet += frame.quiet;
  total.masked += frame.masked;
}

// Transform-code every channel, then overlap-add the segments into a recording. Deleting bins inside processSegment is the lossy step. With nothing discarded, that sum is the original samples.
export async function compress(channels, sampleRate, segmentLength, params, shouldStop) {
  const ws = workspace(segmentLength);
  const n = ws.n;
  // Hop of N/2 is the 50% overlap the Hann window above was built for.
  const hop = n >> 1;
  const outputs = channels.map((channel) => new Float32Array(channel.length));
  const stats = emptyStats();
  let segments = 0;

  for (let c = 0; c < channels.length; c++) {
    const input = channels[c];
    const output = outputs[c];

    // 1. Cut the sound into short segments.
    for (let start = 0; start < input.length; start += hop) {
      const frame = ws.frame;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const sample = start + i < input.length ? input[start + i] : 0;
        frame[i] = sample;
        peak = Math.max(peak, Math.abs(sample));
      }

      const frameStats = processSegment(ws, frame, sampleRate, params);
      // Channel 0 only. The near-silent intro is left out so it does not dominate the kept/discarded percentage.
      if (c === 0 && peak >= 0.015) addStats(stats, frameStats);

      // Deleted components are already gone. This add is only how overlapping segments are joined back into a playable recording.
      for (let i = 0; i < n && start + i < output.length; i++) {
        output[start + i] += ws.timeOut[i];
      }

      segments++;
      // Yield often enough that playback can keep its queue full. Empty stats means this pass was cancelled.
      if (segments % 40 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (shouldStop?.()) return { channels: outputs, stats: emptyStats() };
      }
    }
  }

  // Every segment was under the silence floor. Keep the ratio defined.
  if (stats.bins === 0) stats.bins = stats.kept = 1;
  return { channels: outputs, stats };
}

// Codes audio one hop ahead of the playhead. A parameter change is heard on the next hop, which is the 50% overlap, instead of after the whole file is recompressed.
export function createCoder(segmentLength, sampleRate) {
  const ws = workspace(segmentLength);
  const n = ws.n;
  const hop = n >> 1;
  let inputs = [];
  let params = { cutoffHz: sampleRate / 2, quiet: 0, mask: 0, bypass: false };
  let segmentStart = 0;
  const carry = [];

  function clearCarry() {
    while (carry.length < inputs.length) carry.push(new Float32Array(hop));
    for (let c = 0; c < inputs.length; c++) carry[c].fill(0);
  }

  function synthesize(channel, start) {
    const frame = ws.frame;
    const input = inputs[channel];
    const limit = input.length;
    for (let i = 0; i < n; i++) frame[i] = start + i < limit ? input[start + i] : 0;
    processSegment(ws, frame, sampleRate, params);
  }

  return {
    setSource(channels) {
      inputs = channels;
      segmentStart = 0;
      clearCarry();
    },
    setParams(next) {
      params = next;
    },
    get position() {
      return segmentStart;
    },
    get finished() {
      return inputs.length > 0 && segmentStart >= inputs[0].length + hop;
    },
    // Warm the overlap from the previous hop so a seek does not click.
    seek(sample) {
      const limit = inputs[0] ? inputs[0].length : 0;
      const aligned = Math.max(0, Math.floor(Math.min(sample, limit) / hop) * hop);
      clearCarry();
      if (aligned >= hop) {
        const prev = aligned - hop;
        for (let c = 0; c < inputs.length; c++) {
          synthesize(c, prev);
          const tail = carry[c];
          const timeOut = ws.timeOut;
          for (let i = 0; i < hop; i++) tail[i] = timeOut[hop + i];
        }
      }
      segmentStart = aligned;
      return aligned;
    },
    // `count` is a whole number of hops. Each hop is complete once this segment is added to the previous tail.
    read(count) {
      if (!inputs.length || segmentStart >= inputs[0].length + hop) return null;
      const outs = inputs.map(() => new Float32Array(count));
      let written = 0;
      while (written < count) {
        for (let c = 0; c < inputs.length; c++) {
          synthesize(c, segmentStart);
          const timeOut = ws.timeOut;
          const out = outs[c];
          const tail = carry[c];
          for (let i = 0; i < hop; i++) out[written + i] = tail[i] + timeOut[i];
          for (let i = 0; i < hop; i++) tail[i] = timeOut[hop + i];
        }
        written += hop;
        segmentStart += hop;
      }
      return outs;
    },
  };
}

// The same three steps, on the one segment under the playhead. The returned arrays are copies because the workspace buffers are reused.
export function analyseFrame(frame, sampleRate, params) {
  let ws = previewPool.get(frame.length);
  if (!ws) {
    ws = workspace(frame.length);
    previewPool.set(frame.length, ws);
  }
  const stats = processSegment(ws, frame, sampleRate, params);
  return {
    magnitudes: new Float32Array(ws.magnitudes),
    reasons: new Uint8Array(ws.reasons),
    windowed: new Float32Array(ws.windowed),
    output: new Float32Array(ws.timeOut),
    stats,
    fftSize: frame.length,
  };
}

// Window one segment, turn it into frequencies, drop the ones to discard, and turn what remains back into samples.
function processSegment(ws, frame, sampleRate, params) {
  const { n, fft, window, windowed, timeOut, spectrum, inv, magnitudes, reasons } = ws;
  const nyquistBin = n >> 1;
  const binCount = nyquistBin + 1;
  // k * sampleRate / N hertz
  const binHz = sampleRate / n;

  for (let i = 0; i < n; i++) windowed[i] = frame[i] * window[i];

  // 2. Transform each segment into the frequencies it contains. realTransform fills the first half. completeSpectrum writes the conjugate half, which the inverse needs to come back as real samples. (for ref: https://github.com/indutny/fft.js#usage)
  for (let i = 0; i < spectrum.length; i++) spectrum[i] = 0;
  fft.realTransform(spectrum, windowed);
  fft.completeSpectrum(spectrum);

  // mgnt of bin k. complex value is stored at indexes 2k and 2k + 1.
  let peakInRange = 0;
  for (let k = 0; k < binCount; k++) {
    magnitudes[k] = Math.hypot(spectrum[2 * k], spectrum[2 * k + 1]);
  }

  // 3. Remove what a listener cannot hear: sounds too quiet to register, and quieter sounds drowned out by a louder nearby frequency (masking). High-frequency detail goes too. The peak for "too quiet" is taken only from bins that are still kept.
  for (let k = 0; k < binCount; k++) {
    if (!params.bypass && k * binHz > params.cutoffHz) {
      reasons[k] = HIGH;
    } else {
      reasons[k] = KEPT;
      if (magnitudes[k] > peakInRange) peakInRange = magnitudes[k];
    }
  }
  if (!params.bypass && params.quiet > 0 && peakInRange > 0) {
    const limit = params.quiet * peakInRange;
    for (let k = 0; k < binCount; k++) {
      if (reasons[k] === KEPT && magnitudes[k] < limit) reasons[k] = QUIET;
    }
  }

  if (!params.bypass && params.mask > 0) {
    // One bin is binHz wide, so this is the 180hz neighbourhood in bins.
    const radius = Math.max(1, Math.round(180 / binHz));
    for (let k = 0; k < binCount; k++) {
      if (reasons[k] !== KEPT) continue;
      let loud = 0;
      const from = Math.max(0, k - radius);
      const to = Math.min(nyquistBin, k + radius);
      for (let j = from; j <= to; j++) {
        // High bins are already being deleted, so they do not count as maskers.
        if (j !== k && reasons[j] !== HIGH && magnitudes[j] > loud) loud = magnitudes[j];
      }
      if (magnitudes[k] < params.mask * loud) reasons[k] = MASKED;
    }
  }

  const frameStats = emptyStats();
  frameStats.bins = binCount;
  for (let k = 0; k < binCount; k++) {
    const reason = reasons[k];
    if (reason === KEPT) frameStats.kept++;
    else if (reason === HIGH) frameStats.high++;
    else if (reason === QUIET) frameStats.quiet++;
    else frameStats.masked++;

    if (reason !== KEPT) {
      spectrum[2 * k] = 0;
      spectrum[2 * k + 1] = 0;
      // A real recording's spectrum is conjugate-symmetric: bin N - k is the conjugate of bin k. Zero both, or the inverse comes back complex. Bins 0 and N/2 have no mirror. (for ref: https://dsp.stackexchange.com/questions/84769/is-the-negative-spectrum-by-dft-of-a-real-signal-needed-to-reconstruct-it)
      if (k > 0 && k < nyquistBin) {
        const mirror = (n - k) * 2;
        spectrum[mirror] = 0;
        spectrum[mirror + 1] = 0;
      }
    }
  }

  // inverseTransform divides by N, then writes interleaved complex samples. The imaginary part is ~0, so the time sample is the even index. (for ref: https://github.com/indutny/fft.js/blob/master/lib/fft.js)
  fft.inverseTransform(inv, spectrum);
  for (let i = 0; i < n; i++) timeOut[i] = inv[2 * i];
  return frameStats;
}