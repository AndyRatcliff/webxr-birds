// Port of Assets/Script/Metronome.cs.
//
// The Unity script counts beats on the audio DSP clock (OnAudioFilterRead) and, once per bar,
// picks new target values that Update() eases the GPUFlock parameters towards. Here the beat
// clock is the music element's currentTime, so the choreography stays locked to the song.
// The BrownianMotion amplitude changes are dropped: that component is disabled in AllFlocks.unity.

export class Choreography {
  constructor({ bpm = 128, signatureHi = 4, signatureLo = 4, startDelay = 1.21 } = {}) {
    this.bpm = bpm;
    this.signatureHi = signatureHi;
    this.signatureLo = signatureLo;
    this.startDelay = startDelay; // "delay to get beats to line up (not tempo)"
    this.reset();
  }

  reset() {
    this.tick = 0;
    this.accent = this.signatureHi;
    this.beatCount = 0;
    // Metronome field initialisers
    this.neighbourDistance = 0.2;
    this.boidSpeedVariation = 0.1;
    this.boidSpeed = 8;
    this.lerpSpeed = 5;
  }

  get secondsPerTick() {
    return (60 / this.bpm) * 4 / this.signatureLo;
  }

  /** Fire every tick that has elapsed by `songTime`, then ease `flock` params (Metronome.Update). */
  update(songTime, dt, flock) {
    while (songTime >= this.startDelay + this.tick * this.secondsPerTick) {
      this.tick++;
      if (++this.accent > this.signatureHi) this.accent = 1;
      if (this.accent === 1) this.onBar();
    }

    const lerp = (a, b, t) => a + (b - a) * Math.min(Math.max(t, 0), 1); // Mathf.Lerp clamps t
    flock.NeighbourDistance = lerp(flock.NeighbourDistance, this.neighbourDistance, dt * this.lerpSpeed);
    flock.BoidSpeedVariation = lerp(flock.BoidSpeedVariation, this.boidSpeedVariation, dt * 5.2);
    flock.BoidSpeed = lerp(flock.BoidSpeed, this.boidSpeed, dt * this.lerpSpeed);
  }

  onBar() {
    const b = this.beatCount;
    if (b === 16) {
      this.lerpSpeed = 5;
      this.neighbourDistance = 5;
      this.boidSpeed = 10;
      this.boidSpeedVariation = 0.1;
    }
    if (b > 16 && b < 67) {
      this.lerpSpeed = 0.5;
      if (b >= 60) this.neighbourDistance = this.neighbourDistance >= 3 ? 1 : 3;
      else this.neighbourDistance = 2;
      this.boidSpeed = 6;
      this.boidSpeedVariation = 0.6;
    }
    if (b === 68) {
      this.lerpSpeed = 0.5;
    }
    if (b > 67 && b < 96) {
      this.lerpSpeed = 0.5;
      this.neighbourDistance = 28 - (b - 67);
      this.boidSpeed = (b - 67) / 2 + 0.1;
    }
    if (b === 96) {
      this.lerpSpeed = 5;
      this.neighbourDistance = 5;
      this.boidSpeed = 10;
    }
    if (b > 96 && b < 120) {
      this.neighbourDistance = this.neighbourDistance >= 4 ? 1 : 4;
    }
    if (b === 120) {
      this.lerpSpeed = 0.5;
      this.neighbourDistance = 50;
      this.boidSpeed = 0.01;
      this.boidSpeedVariation = 0;
    }
    this.beatCount++;
  }
}
