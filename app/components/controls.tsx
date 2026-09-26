import { Button, ButtonGroup, Loader, Text } from "@cloudflare/kumo";
import { RangeSlider } from "./range-slider";

export function Controls({ settings, nyquist, cutoff, segmentMs, sampleRate, busy, keptShare, estimate, times, flacBytes, pcmBytes, onPatch, formatHz }) {
  const sizes = [512, 1024, 2048, 4096];

  return (
    <div className="controls">
      <div className="group">
        <Text as="h3" variant="heading">Segment length</Text>
        <ButtonGroup className="lengths">
          {sizes.map((size) => (
            <Button type="button" key={size} variant={settings.fftSize === size ? "primary" : "secondary"} onClick={() => onPatch({ fftSize: size })}>{size}</Button>
          ))}
        </ButtonGroup>
        <Text variant="secondary">{settings.fftSize} samples / {sampleRate} Hz × 1000 = {segmentMs.toFixed(segmentMs >= 10 ? 0 : 1)}ms.</Text>
      </div>

      <div className="fields">
        <Text as="h3" variant="heading">What gets discarded</Text>
        <div className="group">
          <div className="field-label">
            <Text as="span">Highest frequency kept</Text>
            <Text as="span" variant="mono">{formatHz(cutoff, nyquist)}</Text>
          </div>
          <RangeSlider min={200} max={nyquist} step={10} value={cutoff} onChange={(next) => onPatch({ cutoffHz: next })} />
          <Text variant="secondary">High frequencies are the fine detail, the underlying features of the song. Lower frequencies are the more broad and common sounds.</Text>
        </div>
        <div className="group">
          <div className="field-label">
            <Text as="span">Quiet threshold</Text>
            <Text as="span" variant="mono">{Math.round(settings.quiet * 100)}%</Text>
          </div>
          <RangeSlider min={0} max={0.4} step={0.005} value={settings.quiet} onChange={(next) => onPatch({ quiet: next })} />
          <Text variant="secondary">Frequencies quieter than this % of the loudest frequency in each segment will be deleted.</Text>
        </div>
        <div className="group">
          <div className="field-label">
            <Text as="span">Masking</Text>
            <Text as="span" variant="mono">{Math.round(settings.mask * 100)}%</Text>
          </div>
          <RangeSlider min={0} max={0.8} step={0.01} value={settings.mask} onChange={(next) => onPatch({ mask: next })} />
          <Text variant="secondary">Frequencies under this % of louder frequencies within 180Hz around it will be deleted. Its basically the frequencies that will be drowned out are deleted</Text>
        </div>
      </div>

      <div className="size">
        <Text as="h3" variant="heading">Size</Text>
        <dl>
          <div className="size-row">
            <dt><Text as="span" variant="secondary">The original FLAC (lossless)</Text></dt>
            <dd className="size-value"><Text as="span" variant="mono">{(flacBytes / 1_000_000).toFixed(1)} MB</Text></dd>
          </div>
          <div className="size-row">
            <dt><Text as="span" variant="secondary">Raw samples before compression</Text></dt>
            <dd className="size-value"><Text as="span" variant="mono">{(pcmBytes / 1_000_000).toFixed(1)} MB</Text></dd>
          </div>
          <div className="size-row">
            <dt><Text as="span" variant="secondary">Compressed audio</Text></dt>
            <dd className="size-value">{busy ? <Loader size="sm" /> : <Text as="span" variant="mono">{(estimate / 1_000_000).toFixed(1)} MB</Text>}</dd>
          </div>
        </dl>
        {busy ? <Loader size="sm" /> : (
          <div className="group">
            <Text variant="secondary">Summary:</Text>
            <Text variant="secondary">• {Math.round(keptShare * 100)}% of frequencies in the song were kept</Text>
            <Text variant="secondary">• The filesize is {times.toFixed(1)}x smaller than the raw samples</Text>
          </div>
        )}
      </div>
    </div>
  );
}