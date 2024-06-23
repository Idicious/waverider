export class DataLoader {
  load(audioData: { id: string; file: string }[], ctx: AudioContext) {
    return Promise.all(
      audioData.map((data) =>
        fetch(data.file)
          .then((res) => res.arrayBuffer())
          .then((buffer) => ctx.decodeAudioData(buffer))
          .then((buffer) => ({ id: data.id, data: buffer.getChannelData(0) }))
      )
    );
  }
}
