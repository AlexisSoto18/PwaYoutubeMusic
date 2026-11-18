/**
 * YTM Sync Lyrics - Real-Time Acoustic Vocal Activity Detector (VAD)
 * Uses a non-destructive Web Audio tap (video.captureStream() -> AnalyserNode)
 * to analyze the vocal formant frequency band (300 Hz - 3400 Hz), syllabic modulation,
 * and spectral flux in real time without altering or muting native playback routing.
 */

(() => {
  'use strict';

  window.YTMLyrics = window.YTMLyrics || {};

  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let attachedVideo = null;
  let attachedStream = null;
  let freqBuffer = null;
  let timeBuffer = null;

  // --- Acoustic VAD State ---
  let isSignalAvailable = false;
  let nonZeroFramesCount = 0;
  let rollingNoiseFloor = 18;
  let rollingPeakVocal = 75;
  let smoothedVocalScore = 0;
  let prevVocalBandEnergy = 0;

  let isVocalActive = false;
  let hasDetectedFirstVocal = false;
  let firstVocalOnsetTime = null;
  let lastVocalActiveAudioTime = 0;
  let lastSilenceStartAudioTime = 0;
  let lastPhraseOnsetAudioTime = -10;
  let currentVocalStreakMs = 0;
  let currentSilenceStreakMs = 0;
  let lastSampleWallTime = 0;

  /**
   * Reset VAD tracking state on track change.
   */
  function resetTrackState() {
    rollingNoiseFloor = 18;
    rollingPeakVocal = 75;
    smoothedVocalScore = 0;
    prevVocalBandEnergy = 0;
    isVocalActive = false;
    hasDetectedFirstVocal = false;
    firstVocalOnsetTime = null;
    lastVocalActiveAudioTime = 0;
    lastSilenceStartAudioTime = 0;
    lastPhraseOnsetAudioTime = -10;
    currentVocalStreakMs = 0;
    currentSilenceStreakMs = 0;
    lastSampleWallTime = performance.now();
  }

  /**
   * Attach a passive, non-destructive audio tap to the active <video> element via captureStream().
   * Does not reroute <video> output, guaranteeing playback can never be silenced.
   */
  function ensureAttached(video) {
    if (!video) return false;

    try {
      if (!audioCtx) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return false;
        audioCtx = new AudioContextClass();
      }

      if (audioCtx.state === 'suspended' && !video.paused) {
        audioCtx.resume().catch(() => {});
      }

      // Check if already attached to this video with an active audio track
      if (attachedVideo === video && analyser && attachedStream) {
        const tracks = attachedStream.getAudioTracks();
        if (tracks.length > 0 && tracks[0].readyState === 'live') {
          return true;
        }
      }

      const captureFn = video.captureStream || video.mozCaptureStream;
      if (typeof captureFn !== 'function') return false;

      const stream = captureFn.call(video);
      if (!stream) return false;

      const audioTracks = stream.getAudioTracks();
      if (audioTracks.length === 0) {
        return false;
      }

      if (sourceNode) {
        try {
          sourceNode.disconnect();
        } catch (_) {}
      }

      if (!analyser) {
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.65;
        freqBuffer = new Uint8Array(analyser.frequencyBinCount);
        timeBuffer = new Uint8Array(analyser.fftSize);
      }

      sourceNode = audioCtx.createMediaStreamSource(stream);
      // Connect ONLY to analyser (never to audioCtx.destination) so native audio output is untouched
      sourceNode.connect(analyser);

      attachedVideo = video;
      attachedStream = stream;
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Sample the current FFT spectrum and update Vocal Activity Detection state.
   * Distinguishes singing voice (F1/F2 vocal formants 300-3200Hz + harmonic richness)
   * from sub-bass/kick (45-180Hz) and high-frequency percussion (5500-11000Hz).
   */
  function sampleFrame(video, currentAudioTime) {
    if (!video || video.paused) return getState(currentAudioTime);
    if (!ensureAttached(video) || !analyser || !freqBuffer) {
      return getState(currentAudioTime);
    }

    const now = performance.now();
    const dtMs = lastSampleWallTime > 0 ? Math.min(200, Math.max(8, now - lastSampleWallTime)) : 16;
    lastSampleWallTime = now;

    analyser.getByteFrequencyData(freqBuffer);

    const sampleRate = audioCtx.sampleRate || 48000;
    const binHz = sampleRate / analyser.fftSize; // ~23.4 Hz per bin at 48kHz

    const bassStart = Math.max(1, Math.floor(45 / binHz));
    const bassEnd = Math.floor(190 / binHz);

    // Core vocal fundamental + F1/F2 vowel formants (300 Hz - 3200 Hz)
    const vocalStart = Math.floor(300 / binHz);
    const vocalCoreStart = Math.floor(420 / binHz);
    const vocalCoreEnd = Math.floor(2400 / binHz);
    const vocalEnd = Math.floor(3300 / binHz);

    const highStart = Math.floor(5500 / binHz);
    const highEnd = Math.min(freqBuffer.length - 1, Math.floor(11500 / binHz));

    let bassSum = 0;
    let bassCount = 0;
    for (let i = bassStart; i <= bassEnd; i++) {
      bassSum += freqBuffer[i];
      bassCount++;
    }

    let vocalSum = 0;
    let vocalWeightSum = 0;
    let activeFormantBins = 0;
    let maxBinVal = 0;

    for (let i = vocalStart; i <= vocalEnd; i++) {
      const val = freqBuffer[i];
      if (val > maxBinVal) maxBinVal = val;
      // Weight F1-F2 vowel formant core (420-2400Hz) higher
      const weight = (i >= vocalCoreStart && i <= vocalCoreEnd) ? 1.45 : 0.85;
      vocalSum += val * weight;
      vocalWeightSum += weight;
      if (val > rollingNoiseFloor + 22) {
        activeFormantBins++;
      }
    }

    let highSum = 0;
    let highCount = 0;
    for (let i = highStart; i <= highEnd; i++) {
      highSum += freqBuffer[i];
      highCount++;
    }

    const bassEnergy = bassCount > 0 ? (bassSum / bassCount) : 0;
    const vocalBandEnergy = vocalWeightSum > 0 ? (vocalSum / vocalWeightSum) : 0;
    const highEnergy = highCount > 0 ? (highSum / highCount) : 0;

    // Verify we are receiving real decoded PCM data (not zeroed by EME/DRM)
    if (maxBinVal > 3 || bassEnergy > 3) {
      nonZeroFramesCount++;
      if (nonZeroFramesCount >= 5) {
        isSignalAvailable = true;
      }
    }

    if (!isSignalAvailable) {
      return getState(currentAudioTime);
    }

    // Formant broadband fullness: singing voice excites many harmonic bins across 300-3300Hz,
    // whereas a single guitar/accordion note excites fewer narrow bins.
    const totalVocalBins = Math.max(1, vocalEnd - vocalStart + 1);
    const harmonicCoverage = activeFormantBins / totalVocalBins;

    // Spectral flux in the vocal band (detects syllable articulation)
    const vocalFlux = Math.abs(vocalBandEnergy - prevVocalBandEnergy);
    prevVocalBandEnergy = vocalBandEnergy;

    // Suppress pure bass thumps, guitar/requinto body (bassEnergy), and hi-hat/pick transients
    const accompanimentPenalty = Math.max(0, (bassEnergy - vocalBandEnergy * 0.85) * 0.35) + (highEnergy * 0.22);
    const fluxBoost = Math.min(1.25, 0.8 + (vocalFlux * 0.08));
    const rawVocalSignal = Math.max(0, (vocalBandEnergy - accompanimentPenalty) * (0.7 + 0.45 * Math.min(1, harmonicCoverage * 2.0)) * fluxBoost);

    // Update adaptive rolling floor and peak (allow higher floor for loud mastered tracks)
    if (rawVocalSignal < rollingNoiseFloor + 8) {
      rollingNoiseFloor = rollingNoiseFloor * 0.94 + rawVocalSignal * 0.06;
    } else {
      rollingNoiseFloor = rollingNoiseFloor * 0.992 + rawVocalSignal * 0.008;
    }
    rollingNoiseFloor = Math.max(12, Math.min(130, rollingNoiseFloor));

    if (rawVocalSignal > rollingPeakVocal) {
      rollingPeakVocal = rollingPeakVocal * 0.90 + rawVocalSignal * 0.10;
    } else {
      rollingPeakVocal = Math.max(rollingNoiseFloor + 22, rollingPeakVocal * 0.997);
    }

    const dynamicRange = Math.max(18, rollingPeakVocal - rollingNoiseFloor);
    const instantaneousScore = Math.max(0, Math.min(1, (rawVocalSignal - rollingNoiseFloor) / dynamicRange));

    // Smooth score with fast attack and moderate release
    const alpha = instantaneousScore > smoothedVocalScore ? 0.35 : 0.18;
    smoothedVocalScore = smoothedVocalScore * (1 - alpha) + instantaneousScore * alpha;

    // Hysteresis thresholds for vocal activity
    const onsetThreshold = 0.46;
    const sustainThreshold = 0.31;
    const frameHasVoice = isVocalActive
      ? (smoothedVocalScore >= sustainThreshold)
      : (smoothedVocalScore >= onsetThreshold && harmonicCoverage >= 0.18 && vocalFlux >= 0.4);

    let triggeredPhraseOnset = false;

    if (frameHasVoice) {
      currentVocalStreakMs += dtMs;
      currentSilenceStreakMs = 0;

      if (!isVocalActive && currentVocalStreakMs >= 130) {
        const prevSilenceSec = currentAudioTime - lastVocalActiveAudioTime;
        isVocalActive = true;

        if (!hasDetectedFirstVocal && currentAudioTime >= 0.8) {
          hasDetectedFirstVocal = true;
          firstVocalOnsetTime = Math.max(0.4, currentAudioTime - 0.12);
          triggeredPhraseOnset = true;
          lastPhraseOnsetAudioTime = firstVocalOnsetTime;
        } else if (prevSilenceSec >= 0.42 && (currentAudioTime - lastPhraseOnsetAudioTime) >= 1.1) {
          triggeredPhraseOnset = true;
          lastPhraseOnsetAudioTime = Math.max(0.4, currentAudioTime - 0.08);
        }
      }

      if (isVocalActive) {
        lastVocalActiveAudioTime = currentAudioTime;
      }
    } else {
      currentSilenceStreakMs += dtMs;
      currentVocalStreakMs = 0;

      if (isVocalActive && currentSilenceStreakMs >= 320) {
        isVocalActive = false;
        lastSilenceStartAudioTime = currentAudioTime;
      }
    }

    return {
      isSignalAvailable,
      isVocalActive,
      vocalScore: Math.round(smoothedVocalScore * 100) / 100,
      hasDetectedFirstVocal,
      firstVocalOnsetTime,
      triggeredPhraseOnset,
      lastPhraseOnsetAudioTime,
      silenceDurationSec: isVocalActive ? 0 : Math.max(0, currentSilenceStreakMs / 1000)
    };
  }

  function getState(currentAudioTime = 0) {
    return {
      isSignalAvailable,
      isVocalActive,
      vocalScore: Math.round(smoothedVocalScore * 100) / 100,
      hasDetectedFirstVocal,
      firstVocalOnsetTime,
      triggeredPhraseOnset: false,
      lastPhraseOnsetAudioTime,
      silenceDurationSec: isVocalActive ? 0 : Math.max(0, currentSilenceStreakMs / 1000),
      currentAudioTime
    };
  }

  function getDiagnostics(video) {
    let maxBin = 0;
    if (freqBuffer) {
      for (let i = 0; i < freqBuffer.length; i++) {
        if (freqBuffer[i] > maxBin) maxBin = freqBuffer[i];
      }
    }
    const streamTracks = attachedStream ? attachedStream.getAudioTracks().map(t => ({
      readyState: t.readyState,
      enabled: t.enabled,
      muted: t.muted
    })) : [];

    return {
      audioCtxState: audioCtx ? audioCtx.state : 'none',
      sampleRate: audioCtx ? audioCtx.sampleRate : 0,
      hasMediaKeysDRM: Boolean(video && video.mediaKeys),
      videoSrc: video ? (video.currentSrc || video.src || '').slice(0, 48) : 'none',
      streamTracks,
      isSignalAvailable,
      nonZeroFramesCount,
      maxFftBinValue: maxBin,
      rollingNoiseFloor: Math.round(rollingNoiseFloor * 10) / 10,
      rollingPeakVocal: Math.round(rollingPeakVocal * 10) / 10,
      vocalScore: Math.round(smoothedVocalScore * 100) / 100,
      isVocalActive,
      hasDetectedFirstVocal,
      firstVocalOnsetTime
    };
  }

  window.YTMLyrics.AudioVAD = {
    resetTrackState,
    sampleFrame,
    getState,
    getDiagnostics
  };
})();
