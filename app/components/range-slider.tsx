"use client";

import { useEffect, useState } from "react";
import { Slider } from "@cloudflare/kumo/primitives/slider";

export function RangeSlider({ min, max, step, value, onChange }) {
  return (
    <Slider.Root min={min} max={max} step={step} value={value} onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}>
      <Slider.Control className="slider-control">
        <Slider.Track className="slider-track">
          <Slider.Indicator className="slider-indicator" />
          <Slider.Thumb className="slider-thumb" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

export function SeekSlider({ syncRef, duration, scrubbingRef, onSeek, onScrubStart, onScrubEnd }) {
  const [value, setValue] = useState(0);

  useEffect(() => {
    syncRef.current = (next) => {
      if (scrubbingRef.current) return;
      setValue(next);
    };
    return () => {
      syncRef.current = null;
    };
  }, [syncRef, scrubbingRef]);

  return (
    <Slider.Root className="seek" min={0} max={duration || 1} step={0.01} value={value} onValueChange={(next) => { const value = Array.isArray(next) ? next[0] : next; setValue(value); onSeek(value); }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); onScrubStart(); }} onPointerUp={onScrubEnd} onLostPointerCapture={onScrubEnd}>
      <Slider.Control className="seek-control">
        <Slider.Track className="seek-track">
          <Slider.Indicator className="seek-indicator" />
          <Slider.Thumb className="seek-thumb" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}