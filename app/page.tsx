import { LayerCard, Text } from "@cloudflare/kumo";

export default function Home() {
  return (
    <main className="page">
      <div className="stack">
        <div className="lede">
          <Text as="h1" variant="heading" size="lg">Transform coding</Text>
          <Text variant="secondary">Transform coding is where data is turned into a different representation (depending on the kind of file), and then different methods are used to reduce file size. This demo shows how transform coding works in audio files. First, the encoder turns the audio into short segments, and transforms the frequencies each segment contains. It them removes frequencies the listener cannot hear (frequencies too quiet or overlapped by other frequencies). This is called masking. Discarding the inaudible content using transform coding is why audio files around 20-30MB can be shrunk to just 2-3, while sounding nearly identical.</Text>
          <Text variant="secondary">The transform itself is a fast Fourier transform from a JS library (not really relevant for IB syllabus). These controls are the lossy step: what gets thrown away. If nothing gets discarded, the sound will matches the original sample. This demo uses a lossless FLAC file of the song "Miracle Aligner" by The Last Shadow Puppets to show the true extent of the compression.</Text>
        </div>
            <div className="steps">
              <LayerCard className="step"><Text>turn the original data into segments (1024 samples)</Text></LayerCard>
              <LayerCard className="step"><Text>transform each segment into the frequencies it contains</Text></LayerCard>
              <LayerCard className="step"><Text>discard frequencies listeners cannot hear: either too quiet or drowned out by larger freqs (this is called masking)</Text></LayerCard>
              <LayerCard className="step"><Text>hear the lossily compressed audio as you change the parameters</Text></LayerCard>
            </div>
      </div>
    </main>
  );
}
