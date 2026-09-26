"use client";

import { Button, Loader, Text } from "@cloudflare/kumo";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { SeekSlider } from "./range-slider";

export function Player({ meta, playing, busy, bypass, onPatch, onToggle, timeRef, overviewRef, seekSyncRef, scrubbingRef, onSeek, onScrubStart, onScrubEnd, formatTime }) {
  return (
    <section className="player">
      <div className="transport">
        <Button type="button" shape="circle" variant="primary" size="lg" onClick={onToggle}>
          {playing ? <PauseIcon weight="fill" /> : <PlayIcon weight="fill" />}
        </Button>
        <Text as="span" variant="secondary">
          <span ref={timeRef} className="nums">0:00</span>
          <span className="nums"> / {formatTime(meta.duration)}</span>
        </Text>
        {busy && <Loader size="sm" />}
        <div className="playback">
          <Button type="button" variant={bypass ? "secondary" : "primary"} onClick={() => onPatch({ bypass: false })}>Compressed</Button>
          <Button type="button" variant={bypass ? "primary" : "secondary"} onClick={() => onPatch({ bypass: true })}>Original samples</Button>
        </div>
      </div>

      <div className="frame frame-overview">
        <canvas ref={overviewRef} />
        <SeekSlider syncRef={seekSyncRef} duration={meta.duration} scrubbingRef={scrubbingRef} onSeek={onSeek} onScrubStart={onScrubStart} onScrubEnd={onScrubEnd} />
      </div>
    </section>
  );
}