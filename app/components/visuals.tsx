import { Text } from "@cloudflare/kumo";

const SWATCHES = [
  ["swatch-kept", "Kept"],
  ["swatch-high", "High-frequency detail"],
  ["swatch-quiet", "Too quiet"],
  ["swatch-mask", "Masked"],
];

export function Visuals({ spectrumRef, segmentRef }) {
  return (
    <div className="visuals">
      <figure className="figure">
        <div className="frame frame-spectrum">
          <canvas ref={spectrumRef} />
        </div>
        <Text as="figcaption" variant="secondary">Frequencies in the current segment. The dashed line is the highest frequency kept.</Text>
      </figure>
      <ul className="legend">
        {SWATCHES.map(([swatch, label]) => (
          <li key={label}>
            <span className="swatch-wrap"><i className={`swatch ${swatch}`} /></span>
            <Text as="span" variant="secondary">{label}</Text>
          </li>
        ))}
      </ul>
      <figure className="figure">
        <div className="frame frame-segment">
          <canvas ref={segmentRef} />
        </div>
        <Text as="figcaption" variant="secondary">One segment. Grey is the original, green is what remains, and orange is what the discard removed.</Text>
      </figure>
    </div>
  );
}