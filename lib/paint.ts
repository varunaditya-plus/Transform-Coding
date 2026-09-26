const TOKENS = {
  kept: "--color-kumo-success",
  high: "--color-kumo-warning",
  quiet: "--color-kumo-badge-neutral",
  mask: "--color-kumo-info",
  line: "--color-kumo-hairline",
  original: "--text-color-kumo-subtle",
  label: "--text-color-kumo-subtle",
  playhead: "--text-color-kumo-strong",
  unplayed: "--color-kumo-fill",
};

let palette = null;

function tokenColor(name) {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

function colors() {
  if (palette) return palette;
  palette = {};
  for (const key of Object.keys(TOKENS)) palette[key] = tokenColor(TOKENS[key]);
  return palette;
}

// Match the canvas backing store to the screen, then draw in CSS pixels. The ratio is capped at 2 so a 3x display does not triple the pixel work.
function context(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const pixelWidth = Math.floor(width * dpr);
  const pixelHeight = Math.floor(height * dpr);

  // Setting canvas.width clears the bitmap and resets the transform.
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const g = canvas.getContext("2d");
  if (!g) return null;

  // Scale drawing so x y below are CSS pixels.
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, width, height };
}

// Draw one segment's spectrum. Bar colour is the reason from processSegment: kept, high, quiet, masked, in that order.
export function paintSpectrum(canvas, frame, cutoffHz, sampleRate, font) {
  const view = context(canvas);
  if (!view) return;
  const { g, width, height } = view;
  const paint = colors();
  g.clearRect(0, 0, width, height);

  const pad = { left: 8, right: 8, top: 14, bottom: 22 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const magnitudes = frame.magnitudes;
  const reasons = frame.reasons;
  const nyquist = sampleRate / 2;

  g.strokeStyle = paint.line;
  g.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = pad.top + (plotHeight * i) / 4;
    g.beginPath();
    g.moveTo(pad.left, y);
    g.lineTo(pad.left + plotWidth, y);
    g.stroke();
  }

  let peak = 1e-8;
  for (let i = 0; i < magnitudes.length; i++) {
    if (magnitudes[i] > peak) peak = magnitudes[i];
  }

  // Several bins share one pixel column. Draw the loudest of them, and colour the bar by that bin's reason.
  const columns = Math.max(1, Math.floor(plotWidth));
  for (let column = 0; column < columns; column++) {
    const start = Math.floor((column * magnitudes.length) / columns);
    const end = Math.max(start + 1, Math.floor(((column + 1) * magnitudes.length) / columns));
    let best = 0;
    let reason = 0;
    for (let bin = start; bin < end && bin < magnitudes.length; bin++) {
      if (magnitudes[bin] >= best) {
        best = magnitudes[bin];
        reason = reasons[bin] ?? 0;
      }
    }

    // A power below 1 lifts the quieter bars so they stay visible.
    const heightNorm = Math.pow(best / peak, 0.42);
    const barHeight = Math.max(1, heightNorm * plotHeight);
    g.globalAlpha = reason === 0 ? 0.95 : 0.55;
    g.fillStyle = [paint.kept, paint.high, paint.quiet, paint.mask][reason] ?? paint.kept;
    const x = pad.left + (column * plotWidth) / columns;
    const barWidth = Math.max(1, plotWidth / columns);
    g.fillRect(x, pad.top + plotHeight - barHeight, barWidth, barHeight);
  }
  g.globalAlpha = 1;

  // Dashed marker at the cutoff. Skip it when the cutoff is already at Nyquist.
  if (cutoffHz < nyquist - 1) {
    const x = pad.left + (cutoffHz / nyquist) * plotWidth;
    g.strokeStyle = paint.high;
    g.setLineDash([3, 4]);
    g.beginPath();
    g.moveTo(x, pad.top);
    g.lineTo(x, pad.top + plotHeight);
    g.stroke();
    g.setLineDash([]);
  }

  g.fillStyle = paint.label;
  g.font = `12px ${font}`;
  g.textBaseline = "alphabetic";
  const ticks = [0, 5000, 10000, 15000, 20000].filter((tick) => tick <= nyquist + 1);
  for (const tick of ticks) {
    const x = pad.left + (tick / nyquist) * plotWidth;
    const label = tick === 0 ? "0" : `${tick / 1000} kHz`;
    g.fillText(label, tick === 0 ? x : x - 12, height - 6);
  }
}

// Draw the whole song as min-to-max bars. Bars behind the playhead are green.
export function paintOverview(canvas, mins, maxs, position, duration) {
  const view = context(canvas);
  if (!view) return;
  const { g, width, height } = view;
  const paint = colors();
  g.clearRect(0, 0, width, height);
  const mid = height / 2;
  const play = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0;
  const playX = play * width;
  const bucketWidth = width / mins.length;

  for (let i = 0; i < mins.length; i++) {
    const x = i * bucketWidth;

    // 0.46 leaves a gap between the loudest sample and the top and bottom edges.
    const y1 = mid - maxs[i] * (height * 0.46);
    const y2 = mid - mins[i] * (height * 0.46);
    g.strokeStyle = x + bucketWidth < playX ? paint.kept : paint.unplayed;
    g.lineWidth = Math.max(1, bucketWidth * 0.7);
    g.beginPath();
    g.moveTo(x + bucketWidth / 2, y1);
    g.lineTo(x + bucketWidth / 2, y2);
    g.stroke();
  }

  g.strokeStyle = paint.playhead;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(playX, 4);
  g.lineTo(playX, height - 4);
  g.stroke();
}