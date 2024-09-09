export class DataLoader {
  load(audioData: { id: string; url: string }[], ctx: AudioContext) {
    return Promise.all(
      audioData.map((data) =>
        fetch(data.url)
          .then((res) => res.arrayBuffer())
          .then((buffer) => ctx.decodeAudioData(buffer))
          .then((buffer) => ({ id: data.id, data: buffer.getChannelData(0) }))
      )
    );
  }
}
