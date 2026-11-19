/**
 * YTM Sync Lyrics - Offscreen Silero VAD v5 ONNX Runtime Web Inference Engine
 * Runs inside an MV3 Offscreen Document (chrome-extension:// origin with wasm-unsafe-eval)
 * to separate human singing/speaking voice from guitars, requintos, and percussion.
 */

(() => {
  'use strict';

  const SAMPLE_RATE = 16000;
  const FRAME_SIZE = 512;      // 32ms at 16kHz (Silero VAD v5 native window)
  const CONTEXT_SIZE = 64;     // 64-sample lookback context required by Silero VAD v5
  const STATE_SIZE = 2 * 1 * 128;

  let session = null;
  let sessionLoadingPromise = null;
  let initError = null;

  let lstmState = new Float32Array(STATE_SIZE);
  let contextBuffer = new Float32Array(CONTEXT_SIZE);
  let srTensor = null;

  /**
   * Reset Silero v5 recurrent LSTM hidden state and context window (on song change / seek).
   */
  function resetState() {
    lstmState = new Float32Array(STATE_SIZE);
    contextBuffer = new Float32Array(CONTEXT_SIZE);
  }

  /**
   * Lazily initialize ONNX Runtime Web (WASM single-threaded) and load models/silero_vad.onnx.
   */
  async function ensureSession() {
    if (session) return session;
    if (sessionLoadingPromise) return sessionLoadingPromise;

    sessionLoadingPromise = (async () => {
      try {
        if (typeof ort === 'undefined') {
          throw new Error('ONNX Runtime Web (ort) failed to load');
        }

        ort.env.wasm.wasmPaths = chrome.runtime.getURL('lib/ort/');
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;

        const modelUrl = chrome.runtime.getURL('models/silero_vad.onnx');
        const response = await fetch(modelUrl);
        if (!response.ok) {
          throw new Error(`Failed to fetch silero_vad.onnx (${response.status})`);
        }
        const modelBuffer = await response.arrayBuffer();

        session = await ort.InferenceSession.create(modelBuffer, {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'all'
        });

        srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), []);
        initError = null;
        return session;
      } catch (err) {
        initError = String(err?.message || err);
        sessionLoadingPromise = null;
        console.error('[YTM Sync Silero VAD] Init error:', err);
        return null;
      }
    })();

    return sessionLoadingPromise;
  }

  /**
   * Run Silero VAD v5 inference across one or more 512-sample 16kHz frames.
   */
  async function runInference(samplesArray, shouldReset = false) {
    const sess = await ensureSession();
    if (!sess) {
      return { ok: false, error: initError || 'Session unavailable', modelReady: false };
    }

    if (shouldReset) {
      resetState();
    }

    const totalLen = Array.isArray(samplesArray) ? samplesArray.length : 0;
    if (totalLen < FRAME_SIZE) {
      return { ok: true, prob: 0, avgProb: 0, frameProbs: [], modelReady: true };
    }

    const frameProbs = [];
    let maxProb = 0;
    let sumProb = 0;

    for (let offset = 0; offset + FRAME_SIZE <= totalLen; offset += FRAME_SIZE) {
      const inputData = new Float32Array(CONTEXT_SIZE + FRAME_SIZE);
      inputData.set(contextBuffer, 0);
      for (let i = 0; i < FRAME_SIZE; i++) {
        inputData[CONTEXT_SIZE + i] = samplesArray[offset + i];
      }

      // Save last 64 samples of this frame as context for the next frame
      contextBuffer.set(inputData.subarray(FRAME_SIZE, CONTEXT_SIZE + FRAME_SIZE));

      const inputTensor = new ort.Tensor('float32', inputData, [1, CONTEXT_SIZE + FRAME_SIZE]);
      const stateTensor = new ort.Tensor('float32', lstmState, [2, 1, 128]);

      const outputs = await sess.run({
        input: inputTensor,
        state: stateTensor,
        sr: srTensor
      });

      const prob = Number(outputs.output?.data?.[0] || 0);
      if (outputs.stateN?.data) {
        lstmState = new Float32Array(outputs.stateN.data);
      }

      frameProbs.push(Math.round(prob * 1000) / 1000);
      if (prob > maxProb) maxProb = prob;
      sumProb += prob;
    }

    const avgProb = frameProbs.length > 0 ? (sumProb / frameProbs.length) : 0;
    return {
      ok: true,
      prob: Math.round(maxProb * 1000) / 1000,
      avgProb: Math.round(avgProb * 1000) / 1000,
      frameProbs,
      modelReady: true
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'OFFSCREEN_SILERO_RESET') {
      resetState();
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === 'OFFSCREEN_SILERO_INFER') {
      runInference(message.samples, Boolean(message.reset))
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err), modelReady: Boolean(session) }));
      return true;
    }
  });

  // Pre-warm ONNX session on startup
  ensureSession();
})();
