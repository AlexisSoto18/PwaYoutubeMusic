/**
 * YTM Sync Lyrics - Neural Vocal Activity Detector (Silero VAD v5 ONNX / WebAssembly)
 * Uses a passive, non-destructive video.captureStream() tap -> 16kHz PCM downsampler ->
 * MV3 Offscreen ONNX Runtime Web (Silero VAD v5) to separate real human singing voice
 * from loud instrumental intros, requintos, guitars, and percussion.
 */

(() => {
  'use strict';

  window.YTMLyrics = window.YTMLyrics || {};

  const TARGET_SAMPLE_RATE = 16000;
  const BATCH_SAMPLES_16K = 1024; // 2 x 512-sample Silero v5 frames (~64ms low-latency batch)
  const WHISPER_WINDOW_SAMPLES = 16000 * 3.6;  // 3.6s vocal audio window for Whisper Tiny
  const WHISPER_OVERLAP_SAMPLES = 16000 * 0.8; // 0.8s overlap so phrases aren't split across windows

  let audioCtx = null;
  let sourceNode = null;
  let processorNode = null;
  let silentGainNode = null;
  let attachedVideo = null;
  let attachedStream = null;
  let attachedSrc = '';
  let lastAttachAttemptMs = 0;

  // --- PCM Downsampling & IPC Batch State ---
  let pcmQueue16k = [];
  let isInferInFlight = false;
  let pendingModelReset = true;
  let latestAudioTime = 0;

  // --- Whisper Tiny ASR Rolling Window State ---
  let whisperPcmBuffer = [];
  let whisperWindowStartTime = null;
  let isWhisperInFlight = false;
  let whisperEnabled = false;
  let whisperLanguage = null;
  let whisperStatus = 'idle';
  let whisperProgress = 0;
  let whisperDevice = 'wasm';
  let whisperTranscriptsCount = 0;
  let whisperLastTranscript = '';
  let whisperLastLatencyMs = 0;
  let whisperLastError = null;
  let lastWhisperStatusPollMs = 0;

  // --- Neural Silero VAD State ---
  let sileroReady = false;
  let sileroLastError = null;
  let inferencesCount = 0;
  let sileroProb = 0;
  let sileroAvgProb = 0;
  let smoothedProb = 0;
  let peakPcmAmplitude = 0;
  let nonZeroBatchesCount = 0;
  let consecutiveZeroBatches = 0;

  let isSignalAvailable = false;
  let isVocalActive = false;
  let hasDetectedFirstVocal = false;
  let firstVocalOnsetTime = null;
  let lastVocalActiveAudioTime = 0;
  let lastPhraseOnsetAudioTime = -10;
  let currentVocalStreakMs = 0;
  let currentSilenceStreakMs = 0;
  let pendingPhraseOnset = false;
  let lastEvalWallTime = 0;

  /**
   * Downsample Float32 PCM buffer from inputSampleRate (e.g. 48000Hz) to 16000Hz via linear interpolation.
   */
  function downsampleTo16k(inputFloat32, inputSampleRate) {
    if (inputSampleRate === TARGET_SAMPLE_RATE) {
      return inputFloat32;
    }
    const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
    const outputLength = Math.floor(inputFloat32.length / ratio);
    const output = new Float32Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIdx = i * ratio;
      const idx0 = Math.floor(srcIdx);
      const idx1 = Math.min(inputFloat32.length - 1, idx0 + 1);
      const frac = srcIdx - idx0;
      output[i] = inputFloat32[idx0] * (1 - frac) + inputFloat32[idx1] * frac;
    }
    return output;
  }

  /**
   * Reset neural VAD tracking state on track change and force fresh stream + LSTM state reset.
   */
  function resetTrackState() {
    isSignalAvailable = false;
    nonZeroBatchesCount = 0;
    consecutiveZeroBatches = 0;
    pcmQueue16k = [];
    whisperPcmBuffer = [];
    whisperWindowStartTime = null;
    pendingModelReset = true;
    sileroProb = 0;
    sileroAvgProb = 0;
    smoothedProb = 0;
    peakPcmAmplitude = 0;
    isVocalActive = false;
    hasDetectedFirstVocal = false;
    firstVocalOnsetTime = null;
    lastVocalActiveAudioTime = 0;
    lastPhraseOnsetAudioTime = -10;
    currentVocalStreakMs = 0;
    currentSilenceStreakMs = 0;
    pendingPhraseOnset = false;
    attachedSrc = '';
    lastAttachAttemptMs = 0;
    lastEvalWallTime = performance.now();

    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (_) {}
      sourceNode = null;
    }
    attachedVideo = null;
    attachedStream = null;

    try {
      chrome.runtime.sendMessage({ type: 'SILERO_VAD_RESET' }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  /**
   * Update vocal activity state machine from Silero VAD v5 neural speech probability.
   */
  function ingestSileroProbability(maxProb, avgProb, batchAudioTime) {
    const now = performance.now();
    const dtMs = lastEvalWallTime > 0 ? Math.min(250, Math.max(40, now - lastEvalWallTime)) : 96;
    lastEvalWallTime = now;

    sileroProb = maxProb;
    sileroAvgProb = avgProb;

    // Low-latency attack, smooth release on neural voice probability
    const effectiveProb = maxProb * 0.80 + avgProb * 0.20;
    const alpha = effectiveProb > smoothedProb ? 0.72 : 0.32;
    smoothedProb = smoothedProb * (1 - alpha) + effectiveProb * alpha;

    // Silero VAD v5 thresholds tuned for singing over music (instruments stay < 0.20)
    const onsetThreshold = 0.38;
    const sustainThreshold = 0.24;
    const frameHasVoice = isVocalActive
      ? (smoothedProb >= sustainThreshold)
      : (smoothedProb >= onsetThreshold);

    if (frameHasVoice) {
      currentVocalStreakMs += dtMs;
      currentSilenceStreakMs = 0;

      if (!isVocalActive && currentVocalStreakMs >= 64) {
        const prevSilenceSec = batchAudioTime - lastVocalActiveAudioTime;
        isVocalActive = true;

        if (!hasDetectedFirstVocal && batchAudioTime >= 0.8) {
          hasDetectedFirstVocal = true;
          firstVocalOnsetTime = Math.max(0.4, batchAudioTime - 0.22);
          pendingPhraseOnset = true;
          lastPhraseOnsetAudioTime = firstVocalOnsetTime;
        } else if (prevSilenceSec >= 0.45 && (batchAudioTime - lastPhraseOnsetAudioTime) >= 1.1) {
          pendingPhraseOnset = true;
          lastPhraseOnsetAudioTime = Math.max(0.4, batchAudioTime - 0.18);
        }
      }

      if (isVocalActive) {
        lastVocalActiveAudioTime = batchAudioTime;
      }
    } else {
      currentSilenceStreakMs += dtMs;
      currentVocalStreakMs = 0;

      if (isVocalActive && currentSilenceStreakMs >= 360) {
        isVocalActive = false;
      }
    }
  }

  /**
   * Enable Whisper Tiny ASR and optionally warm up the model for a plain-lyrics track.
   */
  function configureWhisper(enabled, language = null) {
    whisperEnabled = Boolean(enabled);
    whisperLanguage = language;
    if (whisperEnabled && whisperStatus === 'idle') {
      whisperStatus = 'loading';
      try {
        chrome.runtime.sendMessage({ type: 'WHISPER_ASR_WARMUP' }, (res) => {
          void chrome.runtime.lastError;
          if (res) {
            whisperStatus = res.status || whisperStatus;
            whisperProgress = res.progress || whisperProgress;
            whisperDevice = res.device || whisperDevice;
            whisperLastError = res.error || null;
          }
        });
      } catch (_) {}
    }
  }

  /**
   * Poll Whisper model download progress while loading so the UI badge can show progress.
   */
  function pollWhisperProgressIfLoading() {
    if (!whisperEnabled || whisperStatus !== 'loading') return;
    const now = performance.now();
    if (now - lastWhisperStatusPollMs < 1200) return;
    lastWhisperStatusPollMs = now;

    try {
      chrome.runtime.sendMessage({ type: 'WHISPER_ASR_STATUS' }, (res) => {
        void chrome.runtime.lastError;
        if (!res) return;
        whisperStatus = res.status || whisperStatus;
        whisperProgress = res.progress || whisperProgress;
        whisperDevice = res.device || whisperDevice;
        whisperLastError = res.error || null;
        window.dispatchEvent(new CustomEvent('ytm-lyrics-whisper-status', {
          detail: { status: whisperStatus, progress: whisperProgress, device: whisperDevice }
        }));
      });
    } catch (_) {}
  }

  /**
   * Dispatch a 3.6s vocal audio window to Whisper Tiny in the MV3 Offscreen worker.
   */
  function dispatchWhisperWindow(samples, startTime, endTime) {
    if (!whisperEnabled || isWhisperInFlight) return;
    isWhisperInFlight = true;

    try {
      chrome.runtime.sendMessage(
        {
          type: 'WHISPER_ASR_TRANSCRIBE',
          samples,
          windowStartTime: startTime,
          windowEndTime: endTime,
          language: whisperLanguage
        },
        (res) => {
          isWhisperInFlight = false;
          if (chrome.runtime.lastError) {
            whisperLastError = chrome.runtime.lastError.message;
            return;
          }
          if (!res) return;
          whisperStatus = res.status || whisperStatus;
          whisperProgress = res.progress ?? whisperProgress;
          whisperDevice = res.device || whisperDevice;

          if (!res.ok) {
            whisperLastError = res.error || 'Whisper transcription failed';
            return;
          }

          whisperLastError = null;
          whisperTranscriptsCount = res.transcriptsCount || (whisperTranscriptsCount + 1);
          whisperLastLatencyMs = res.elapsedMs || 0;
          if (res.text) {
            whisperLastTranscript = res.text;
            window.dispatchEvent(new CustomEvent('ytm-lyrics-whisper-transcript', {
              detail: {
                text: res.text,
                windowStartTime: res.windowStartTime,
                windowEndTime: res.windowEndTime,
                elapsedMs: res.elapsedMs,
                device: res.device
              }
            }));
          }
        }
      );
    } catch (err) {
      isWhisperInFlight = false;
      whisperLastError = String(err?.message || err);
    }
  }

  /**
   * Dispatch a 16kHz PCM batch to the MV3 Offscreen Silero VAD v5 ONNX engine.
   */
  function dispatchSileroBatch(batchSamples, batchAudioTime) {
    if (isInferInFlight) return;
    isInferInFlight = true;
    const shouldReset = pendingModelReset;
    pendingModelReset = false;

    try {
      chrome.runtime.sendMessage(
        {
          type: 'SILERO_VAD_INFER',
          samples: batchSamples,
          reset: shouldReset
        },
        (res) => {
          isInferInFlight = false;
          if (chrome.runtime.lastError) {
            sileroLastError = chrome.runtime.lastError.message;
            return;
          }
          if (!res || !res.ok) {
            sileroLastError = res?.error || 'Silero inference failed';
            return;
          }
          sileroReady = Boolean(res.modelReady);
          sileroLastError = null;
          inferencesCount++;
          ingestSileroProbability(res.prob || 0, res.avgProb || 0, batchAudioTime);
        }
      );
    } catch (err) {
      isInferInFlight = false;
      sileroLastError = String(err?.message || err);
    }
  }

  /**
   * Attach a passive, non-destructive audio tap to the active <video> element via captureStream().
   * Only re-attaches when <video>.currentSrc changes or the isolated track ends.
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

      const currentSrc = video.currentSrc || video.src || '';
      const hasLiveTrack = Boolean(attachedStream) &&
        attachedStream.getAudioTracks().some(t => t.readyState === 'live');

      if (attachedVideo === video && processorNode && hasLiveTrack && currentSrc === attachedSrc) {
        return true;
      }

      const nowMs = performance.now();
      if (nowMs - lastAttachAttemptMs < 1000) {
        return hasLiveTrack;
      }
      lastAttachAttemptMs = nowMs;

      const captureFn = video.captureStream || video.mozCaptureStream;
      if (typeof captureFn !== 'function') return false;

      const rawStream = captureFn.call(video);
      if (!rawStream) return false;

      const liveAudioTracks = rawStream.getAudioTracks().filter(t => t.readyState === 'live');
      if (liveAudioTracks.length === 0) return false;

      if (sourceNode) {
        try {
          sourceNode.disconnect();
        } catch (_) {}
      }

      if (!processorNode) {
        processorNode = audioCtx.createScriptProcessor(2048, 1, 1);
        silentGainNode = audioCtx.createGain();
        silentGainNode.gain.value = 0;

        processorNode.onaudioprocess = (event) => {
          if (!attachedVideo || attachedVideo.paused) return;
          const input = event.inputBuffer.getChannelData(0);

          let maxAmp = 0;
          for (let i = 0; i < input.length; i += 4) {
            const abs = Math.abs(input[i]);
            if (abs > maxAmp) maxAmp = abs;
          }
          peakPcmAmplitude = Math.round(maxAmp * 1000) / 1000;

          if (maxAmp < 0.0005) {
            consecutiveZeroBatches++;
            if (consecutiveZeroBatches >= 25) {
              isSignalAvailable = false;
              nonZeroBatchesCount = 0;
              attachedStream = null;
            }
            return;
          }

          consecutiveZeroBatches = 0;
          nonZeroBatchesCount++;
          if (nonZeroBatchesCount >= 2 && sileroReady) {
            isSignalAvailable = true;
          }

          const downsampled = downsampleTo16k(input, audioCtx.sampleRate || 48000);
          for (let i = 0; i < downsampled.length; i++) {
            pcmQueue16k.push(downsampled[i]);
          }

          if (pcmQueue16k.length >= BATCH_SAMPLES_16K) {
            const batch = pcmQueue16k.slice(0, BATCH_SAMPLES_16K);
            pcmQueue16k = pcmQueue16k.slice(BATCH_SAMPLES_16K);
            if (pcmQueue16k.length > BATCH_SAMPLES_16K * 2) {
              pcmQueue16k = pcmQueue16k.slice(-BATCH_SAMPLES_16K);
            }
            dispatchSileroBatch(batch, latestAudioTime);
          }

          // Feed Silero-gated vocal audio into Whisper Tiny rolling 3.6s window
          if (whisperEnabled && sileroReady) {
            if (isVocalActive || smoothedProb >= 0.28) {
              if (whisperPcmBuffer.length === 0) {
                whisperWindowStartTime = Math.max(0, latestAudioTime - 0.15);
              }
              for (let i = 0; i < downsampled.length; i++) {
                whisperPcmBuffer.push(downsampled[i]);
              }
              if (whisperPcmBuffer.length >= WHISPER_WINDOW_SAMPLES) {
                const winSamples = whisperPcmBuffer.slice(0, WHISPER_WINDOW_SAMPLES);
                const startT = whisperWindowStartTime ?? Math.max(0, latestAudioTime - 3.6);
                const endT = latestAudioTime;
                // Keep 0.8s overlap so phrases crossing window edges stay intact
                whisperPcmBuffer = whisperPcmBuffer.slice(WHISPER_WINDOW_SAMPLES - WHISPER_OVERLAP_SAMPLES);
                whisperWindowStartTime = Math.max(0, endT - 0.8);
                dispatchWhisperWindow(winSamples, startT, endT);
              }
            } else if (whisperPcmBuffer.length > 16000 * 1.4 && currentSilenceStreakMs >= 900) {
              // Flush remaining vocal phrase right when a silence/instrumental break begins
              const winSamples = whisperPcmBuffer.slice();
              const startT = whisperWindowStartTime ?? Math.max(0, latestAudioTime - (winSamples.length / 16000));
              const endT = latestAudioTime;
              whisperPcmBuffer = [];
              whisperWindowStartTime = null;
              dispatchWhisperWindow(winSamples, startT, endT);
            } else if (currentSilenceStreakMs >= 1600 && whisperPcmBuffer.length > 0) {
              whisperPcmBuffer = [];
              whisperWindowStartTime = null;
            }
          }
        };

        processorNode.connect(silentGainNode);
        silentGainNode.connect(audioCtx.destination);
      }

      const latestTrack = liveAudioTracks[liveAudioTracks.length - 1];
      const isolatedStream = new MediaStream([latestTrack]);

      sourceNode = audioCtx.createMediaStreamSource(isolatedStream);
      sourceNode.connect(processorNode);

      attachedVideo = video;
      attachedStream = isolatedStream;
      attachedSrc = currentSrc;
      return true;
    } catch (e) {
      sileroLastError = String(e?.message || e);
      return false;
    }
  }

  /**
   * Called from the 60fps sync loop to keep stream attached and return latest Silero VAD state.
   */
  function sampleFrame(video, currentAudioTime) {
    latestAudioTime = currentAudioTime;
    if (!video || video.paused) {
      return getState(currentAudioTime);
    }

    ensureAttached(video);
    pollWhisperProgressIfLoading();

    if (nonZeroBatchesCount >= 2 && sileroReady) {
      isSignalAvailable = true;
    }

    const firedOnset = pendingPhraseOnset;
    pendingPhraseOnset = false;

    return {
      isSignalAvailable: isSignalAvailable && sileroReady,
      isVocalActive,
      vocalScore: Math.round(smoothedProb * 100) / 100,
      hasDetectedFirstVocal,
      firstVocalOnsetTime,
      triggeredPhraseOnset: firedOnset,
      lastPhraseOnsetAudioTime,
      silenceDurationSec: isVocalActive ? 0 : Math.max(0, currentSilenceStreakMs / 1000)
    };
  }

  function getState(currentAudioTime = 0) {
    return {
      isSignalAvailable: isSignalAvailable && sileroReady,
      isVocalActive,
      vocalScore: Math.round(smoothedProb * 100) / 100,
      hasDetectedFirstVocal,
      firstVocalOnsetTime,
      triggeredPhraseOnset: false,
      lastPhraseOnsetAudioTime,
      silenceDurationSec: isVocalActive ? 0 : Math.max(0, currentSilenceStreakMs / 1000),
      currentAudioTime
    };
  }

  function getDiagnostics(video) {
    const streamTracks = attachedStream ? attachedStream.getAudioTracks().map(t => ({
      readyState: t.readyState,
      enabled: t.enabled,
      muted: t.muted
    })) : [];

    return {
      engine: 'silero-vad-v5 + whisper-tiny-onnx',
      sileroReady,
      sileroLastError,
      inferencesCount,
      sileroProb,
      sileroAvgProb,
      smoothedProb: Math.round(smoothedProb * 1000) / 1000,
      peakPcmAmplitude,
      audioCtxState: audioCtx ? audioCtx.state : 'none',
      sampleRate: audioCtx ? audioCtx.sampleRate : 0,
      hasMediaKeysDRM: Boolean(video && video.mediaKeys),
      videoSrc: video ? (video.currentSrc || video.src || '').slice(0, 48) : 'none',
      streamTracks,
      isSignalAvailable: isSignalAvailable && sileroReady,
      nonZeroBatchesCount,
      isVocalActive,
      hasDetectedFirstVocal,
      firstVocalOnsetTime,
      whisper: {
        enabled: whisperEnabled,
        status: whisperStatus,
        progress: whisperProgress,
        device: whisperDevice,
        language: whisperLanguage,
        transcriptsCount: whisperTranscriptsCount,
        lastTranscript: whisperLastTranscript,
        lastLatencyMs: whisperLastLatencyMs,
        lastError: whisperLastError
      }
    };
  }

  window.YTMLyrics.AudioVAD = {
    resetTrackState,
    configureWhisper,
    sampleFrame,
    getState,
    getDiagnostics
  };
})();
