/**
 * YTM Sync Lyrics - Offscreen Whisper Tiny ASR Engine (Transformers.js v3 / ONNX)
 * Runs inside the MV3 Offscreen Document alongside Silero VAD v5.
 * Transcribes 3.5-4.0s vocal windows (gated by Silero VAD) into real words so
 * ForcedAlignment can lock onto the exact sung lyric line even across tempo changes.
 */

import { env, pipeline } from '../lib/transformers/transformers.min.js';

const MODEL_ID = 'onnx-community/whisper-tiny';

// Common Whisper hallucinations on noisy music segments to filter out
const HALLUCINATION_PATTERNS = [
  /^[\s.,!?¡¿♪♫♬\[\]\(\)\-]+$/,
  /(.)\1{6,}/,
  /subt[ií]tulos\s+(realizados|por|creados)/i,
  /gracias\s+por\s+(ver|escuchar)/i,
  /suscr[ií]bete/i,
  /amara\.org/i,
  /^m[uú]sica$/i,
  /^music$/i,
  /^you$/i,
  /^thank you\.?$/i
];

let transcriber = null;
let loadPromise = null;
let status = 'idle'; // 'idle' | 'loading' | 'ready' | 'error'
let downloadProgress = 0;
let activeDevice = 'wasm';
let lastError = null;
let transcriptsCount = 0;
let lastTranscript = '';
let lastLatencyMs = 0;

/**
 * Configure Transformers.js v3 to load ONNX WASM binaries strictly from local extension files
 * (satisfying MV3 CSP) while caching Hugging Face model weights in Browser Cache API.
 */
function configureTransformersEnv() {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/transformers/');
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }
}

/**
 * Detect whether WebGPU is available in this browser/GPU environment.
 */
async function detectBestDevice() {
  try {
    if (typeof navigator !== 'undefined' && navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    }
  } catch (_) {}
  return 'wasm';
}

/**
 * Lazily load Whisper Tiny quantized (q8) pipeline.
 */
async function ensureTranscriber() {
  if (transcriber) return transcriber;
  if (loadPromise) return loadPromise;

  status = 'loading';
  downloadProgress = 0;
  lastError = null;

  loadPromise = (async () => {
    try {
      configureTransformersEnv();
      activeDevice = await detectBestDevice();

      const fileProgress = new Map();
      const onProgress = (info) => {
        if (!info) return;
        if (info.status === 'progress' && info.file && typeof info.progress === 'number') {
          fileProgress.set(info.file, info.progress);
          let sum = 0;
          for (const val of fileProgress.values()) sum += val;
          downloadProgress = Math.min(99, Math.round(sum / Math.max(1, fileProgress.size)));
        } else if (info.status === 'ready') {
          downloadProgress = 100;
        }
      };

      try {
        transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
          dtype: activeDevice === 'webgpu'
            ? { encoder_model: 'fp32', decoder_model_merged: 'q4' }
            : 'q8',
          device: activeDevice,
          progress_callback: onProgress
        });
      } catch (gpuErr) {
        if (activeDevice === 'webgpu') {
          activeDevice = 'wasm';
          transcriber = await pipeline('automatic-speech-recognition', MODEL_ID, {
            dtype: 'q8',
            device: 'wasm',
            progress_callback: onProgress
          });
        } else {
          throw gpuErr;
        }
      }

      status = 'ready';
      downloadProgress = 100;
      lastError = null;
      return transcriber;
    } catch (err) {
      status = 'error';
      lastError = String(err?.message || err);
      loadPromise = null;
      console.error('[YTM Sync Whisper] Load error:', err);
      return null;
    }
  })();

  return loadPromise;
}

/**
 * Clean Whisper output text and filter out empty/hallucinated segments.
 */
function cleanWhisperOutput(rawText) {
  const cleaned = (rawText || '')
    .replace(/\[.*?\]/g, ' ')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[♪♫♬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length < 3) return '';
  for (const rx of HALLUCINATION_PATTERNS) {
    if (rx.test(cleaned)) return '';
  }
  return cleaned;
}

/**
 * Transcribe a 16kHz Float32 audio snippet.
 */
async function transcribeWindow(samplesArray, windowStartTime, windowEndTime, language = null) {
  const pipe = await ensureTranscriber();
  if (!pipe) {
    return {
      ok: false,
      status,
      progress: downloadProgress,
      device: activeDevice,
      error: lastError || 'Whisper pipeline unavailable'
    };
  }

  const t0 = performance.now();
  try {
    const audio = new Float32Array(samplesArray);
    const options = {
      task: 'transcribe',
      return_timestamps: false,
      max_new_tokens: 48,
      no_repeat_ngram_size: 3,
      repetition_penalty: 1.15
    };
    if (language) {
      options.language = language;
    }

    const output = await pipe(audio, options);
    const elapsedMs = Math.round(performance.now() - t0);
    const text = cleanWhisperOutput(output?.text || '');

    transcriptsCount++;
    lastLatencyMs = elapsedMs;
    if (text) {
      lastTranscript = text;
    }

    return {
      ok: true,
      status: 'ready',
      progress: 100,
      device: activeDevice,
      text,
      windowStartTime,
      windowEndTime,
      elapsedMs,
      transcriptsCount
    };
  } catch (err) {
    lastError = String(err?.message || err);
    return {
      ok: false,
      status,
      progress: downloadProgress,
      device: activeDevice,
      error: lastError
    };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'OFFSCREEN_WHISPER_STATUS') {
    sendResponse({
      ok: true,
      status,
      progress: downloadProgress,
      device: activeDevice,
      transcriptsCount,
      lastTranscript,
      lastLatencyMs,
      error: lastError
    });
    return false;
  }

  if (message?.type === 'OFFSCREEN_WHISPER_WARMUP') {
    ensureTranscriber().then((pipe) => {
      sendResponse({
        ok: Boolean(pipe),
        status,
        progress: downloadProgress,
        device: activeDevice,
        error: lastError
      });
    });
    return true;
  }

  if (message?.type === 'OFFSCREEN_WHISPER_TRANSCRIBE') {
    transcribeWindow(
      message.samples,
      message.windowStartTime,
      message.windowEndTime,
      message.language || null
    ).then((res) => sendResponse(res));
    return true;
  }
});
