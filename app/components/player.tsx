"use client";

import { useRef } from "react";
import { Button, Loader, Text } from "@cloudflare/kumo";
import { PauseIcon, PlayIcon } from "@phosphor-icons/react";
import { SeekSlider } from "./range-slider";

export function Player({ meta, playing, busy, bypass, onPatch, onToggle, onUpload, timeRef, overviewRef, seekSyncRef, scrubbingRef, onSeek, onScrubStart, onScrubEnd, formatTime }) {
  const fileRef = useRef(null);
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
          <span className="playback-divider" />
          <Button type="button" variant="secondary" onClick={() => fileRef.current?.click()}>Upload</Button>
          <input ref={fileRef} className="file-input" type="file" accept="audio/*,.flac,.wav,.mp3,.m4a,.aac,.ogg,.aiff,.aif,.webm" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) onUpload(file); }} />
        </div>
      </div>

      <div className="frame frame-overview">
        <canvas ref={overviewRef} />
        <SeekSlider syncRef={seekSyncRef} duration={meta.duration} scrubbingRef={scrubbingRef} onSeek={onSeek} onScrubStart={onScrubStart} onScrubEnd={onScrubEnd} />
      </div>
    </section>
  );
}