"use client";

import { Button, Text } from "@cloudflare/kumo";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { SeekSlider } from "./range-slider";

export function Player({ meta, playing, onToggle, timeRef, overviewRef, seekSyncRef, scrubbingRef, onSeek, onScrubStart, onScrubEnd, formatTime }) {
  return (
    <section className="player">
      <div className="transport">
        <Button type="button" title={playing ? "Pause" : "Play"} shape="circle" variant="primary" size="lg" onClick={onToggle}>
          {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
        </Button>
        <Text as="span" variant="secondary">
          <span ref={timeRef} className="nums">0:00</span>
          <span className="nums"> / {formatTime(meta.duration)}</span>
        </Text>
      </div>
      <div className="frame frame-overview">
        <canvas ref={overviewRef} />
        <SeekSlider syncRef={seekSyncRef} duration={meta.duration} scrubbingRef={scrubbingRef} onSeek={onSeek} onScrubStart={onScrubStart} onScrubEnd={onScrubEnd} />
      </div>
    </section>
  );
}
