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
    reasons[k] = KEPT;
    if (magnitudes[k] > peakInRange) peakInRange = magnitudes[k];
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