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