import { Badge, Text } from "@cloudflare/kumo";

const SPECTRUM = [
  ["success", "Kept"],
  ["warning", "High-frequency detail"],
  ["neutral", "Too quiet"],
  ["neutral", "Masked", "legend-mask"],
];

const SEGMENT = [
  ["neutral", "Original audio"],
  ["success", "What remains"],
  ["warning", "Removed"],
];

export function Visuals({ spectrumRef, segmentRef }) {
  return (
    <div className="visuals">
      <figure className="figure">
        <div className="frame frame-spectrum">
          <canvas ref={spectrumRef} />
        </div>
        <Text as="figcaption" variant="secondary">Frequencies in the current segment across the whole song. The dashed line is the highest frequency kept.</Text>
        <div className="legend">
          {SPECTRUM.map(([variant, label, className]) => (
            <Badge key={label} variant={variant} appearance="dot" className={className}>{label}</Badge>
          ))}
        </div>
      </figure>
      <figure className="figure">
        <div className="frame frame-segment">
          <canvas ref={segmentRef} />
        </div>
        <div className="legend">
          {SEGMENT.map(([variant, label]) => (
            <Badge key={label} variant={variant} appearance="dot">{label}</Badge>
          ))}
        </div>
      </figure>
    </div>
  );
}