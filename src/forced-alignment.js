/**
 * YTM Sync Lyrics - Forced Alignment Engine (DTW / Viterbi & Live Acoustic VAD Alignment)
 * Aligns plain text lyrics (YTM PLAIN / PLAIN) to audio timestamps using:
 * 1. Dynamic Time Warping (DTW) & Viterbi monotonic path decoding against CTC/ASR segments.
 * 2. Multi-Anchor Piecewise Phonetic Interpolation with Local Singer Tempo Learning.
 * 3. Live Acoustic VAD Coupling (Intro Hold, Instrumental/Requinto Freeze, Phrase Onset Snap).
 */

(() => {
  'use strict';

  window.YTMLyrics = window.YTMLyrics || {};

  // Natural human singing pace baseline: ~0.27s per phonetic weight unit (~2.4s - 3.2s per verse)
  const NATURAL_SEC_PER_WEIGHT = 0.27;
  const MIN_SEC_PER_WEIGHT = 0.13;
  const MAX_SEC_PER_WEIGHT = 0.58;

  /**
   * Build structured phonetic line units from plain text lyrics.
   */
  function buildPhoneticLineUnits(plainText) {
    const { analyzeLinePhonetics } = window.YTMLyrics.Phonetics;
    const rawLines = (plainText || '').split('\n');
    const units = [];
    let pendingStanzaBreak = false;

    for (const raw of rawLines) {
      const text = raw.trim();
      if (!text) {
        if (units.length > 0) pendingStanzaBreak = true;
        continue;
      }

      const phonetics = analyzeLinePhonetics(text);
      units.push({
        text,
        phoneticCode: phonetics.phoneticCode,
        syllableCount: phonetics.syllableCount,
        lineWeight: phonetics.durationWeight,
        hasStanzaBreakBefore: pendingStanzaBreak,
        pauseWeightBefore: 0,
        anchorTime: null
      });
      pendingStanzaBreak = false;
    }

    if (units.length === 0) return [];

    // Identify main mid-song instrumental interlude (requinto/solo closest to 50% of lines)
    let midBridgeIndex = -1;
    let bestDistFromMid = Infinity;
    const midPoint = units.length * 0.5;

    for (let i = 1; i < units.length; i++) {
      if (units[i].hasStanzaBreakBefore) {
        const ratio = i / units.length;
        if (ratio >= 0.35 && ratio <= 0.68) {
          const dist = Math.abs(i - midPoint);
          if (dist < bestDistFromMid) {
            bestDistFromMid = dist;
            midBridgeIndex = i;
          }
        }
      }
    }

    for (let i = 0; i < units.length; i++) {
      if (units[i].hasStanzaBreakBefore) {
        units[i].pauseWeightBefore = (i === midBridgeIndex) ? 10.5 : 2.5;
      }
    }

    return units;
  }

  /**
   * Compute total phonetic + pause weight between two unit indices [startIdx .. endIdx].
   */
  function computeSpanWeight(units, startIdx, endIdx, includeEndLineWeight = true) {
    let totalWeight = 0;
    const last = includeEndLineWeight ? endIdx : (endIdx - 1);
    for (let i = startIdx; i <= last; i++) {
      const pauseW = (i === startIdx) ? 0 : units[i].pauseWeightBefore;
      totalWeight += pauseW + units[i].lineWeight;
    }
    if (!includeEndLineWeight && endIdx > startIdx) {
      totalWeight += units[endIdx].pauseWeightBefore;
    }
    return Math.max(0.5, totalWeight);
  }

  /**
   * Distribute timestamps across a slice of units [startIdx..endIdx] spanning [startTime..endTime]
   * weighted by each unit's phonetic syllables and stanza pauses.
   */
  function interpolateUnitsSpan(units, startIdx, endIdx, startTime, endTime) {
    const totalWeight = computeSpanWeight(units, startIdx, endIdx, true);
    const spanSeconds = Math.max(0.4, endTime - startTime);
    const scale = spanSeconds / totalWeight;
    let cursor = startTime;

    for (let i = startIdx; i <= endIdx; i++) {
      if (i > startIdx) {
        cursor += units[i].pauseWeightBefore * scale;
      }
      units[i].time = Math.round(cursor * 100) / 100;
      cursor += units[i].lineWeight * scale;
    }
  }

  /**
   * Build candidate ASR phrases from word/segment streams for line-level DTW matching.
   */
  function buildASRCandidates(asrSegments) {
    if (!Array.isArray(asrSegments) || asrSegments.length === 0) return [];

    const allWords = [];
    for (const seg of asrSegments) {
      if (Array.isArray(seg.words) && seg.words.length > 0) {
        for (const w of seg.words) {
          allWords.push({ time: w.time, text: w.text });
        }
      } else if (seg.text) {
        const splitWords = seg.text.split(/\s+/);
        const dur = Math.max(0.5, (seg.endTime || seg.time + 2) - seg.time);
        splitWords.forEach((w, idx) => {
          allWords.push({
            time: seg.time + (dur * (idx / splitWords.length)),
            text: w
          });
        });
      }
    }

    if (allWords.length === 0) return [];

    const candidates = [];
    for (const seg of asrSegments) {
      candidates.push({ time: seg.time, text: seg.text });
    }
    for (let i = 0; i < allWords.length; i++) {
      let phrase = '';
      for (let len = 1; len <= 9 && (i + len) <= allWords.length; len++) {
        phrase += (len > 1 ? ' ' : '') + allWords[i + len - 1].text;
        if (len >= 3) {
          candidates.push({ time: allWords[i].time, text: phrase });
        }
      }
    }

    return candidates.sort((a, b) => a.time - b.time);
  }

  /**
   * Solve piecewise timestamps across all units given any set of locked anchors (unit.anchorTime)
   * using Local Singer Tempo Learning so tempo changes between anchors propagate forward naturally.
   */
  function solvePiecewiseWithLocalTempo(units, dur, introDefault, maxSingingEnd) {
    const anchoredIndices = [];
    for (let i = 0; i < units.length; i++) {
      if (typeof units[i].anchorTime === 'number' && !Number.isNaN(units[i].anchorTime)) {
        anchoredIndices.push(i);
      }
    }

    if (anchoredIndices.length === 0) {
      interpolateUnitsSpan(units, 0, units.length - 1, introDefault, maxSingingEnd);
      return;
    }

    // 1. Before first anchor: back-project using natural or local singing pace
    const firstAnchorIdx = anchoredIndices[0];
    const firstAnchorTime = units[firstAnchorIdx].anchorTime;

    if (firstAnchorIdx > 0) {
      const preWeight = computeSpanWeight(units, 0, firstAnchorIdx, false);
      const estimatedStart = Math.max(0.8, firstAnchorTime - preWeight * NATURAL_SEC_PER_WEIGHT);
      interpolateUnitsSpan(units, 0, firstAnchorIdx, estimatedStart, firstAnchorTime);
    }
    units[firstAnchorIdx].time = Math.round(firstAnchorTime * 100) / 100;

    // 2. Between consecutive anchors: exact piecewise phonetic interpolation
    let latestObservedSecPerWeight = NATURAL_SEC_PER_WEIGHT;

    for (let k = 0; k < anchoredIndices.length - 1; k++) {
      const idxA = anchoredIndices[k];
      const idxB = anchoredIndices[k + 1];
      const timeA = units[idxA].anchorTime;
      const timeB = units[idxB].anchorTime;

      const spanW = computeSpanWeight(units, idxA, idxB, false);
      const spanDt = Math.max(0.3, timeB - timeA);

      // If the two anchors are reasonably close (<= 14 lines apart, not spanning a huge instrumental solo),
      // learn the singer's real local tempo (seconds per phonetic weight).
      if (idxB - idxA <= 14) {
        const observed = spanDt / spanW;
        latestObservedSecPerWeight = Math.max(MIN_SEC_PER_WEIGHT, Math.min(MAX_SEC_PER_WEIGHT, observed));
      }

      if (idxB - idxA === 1) {
        units[idxB].time = Math.round(timeB * 100) / 100;
      } else {
        interpolateUnitsSpan(units, idxA, idxB, timeA, timeB);
        units[idxA].time = Math.round(timeA * 100) / 100;
        units[idxB].time = Math.round(timeB * 100) / 100;
      }
    }

    // 3. After the last anchor: project forward using learned local singer tempo blended with remaining duration
    const lastAnchorIdx = anchoredIndices[anchoredIndices.length - 1];
    if (lastAnchorIdx < units.length - 1) {
      const lastAnchorTime = units[lastAnchorIdx].anchorTime;
      const remainingWeight = computeSpanWeight(units, lastAnchorIdx, units.length - 1, true);
      const globalBudgetEnd = Math.max(lastAnchorTime + (units.length - lastAnchorIdx) * 1.4, maxSingingEnd);
      const globalSecPerWeight = Math.max(
        MIN_SEC_PER_WEIGHT,
        Math.min(MAX_SEC_PER_WEIGHT, (globalBudgetEnd - lastAnchorTime) / remainingWeight)
      );

      // When 2+ anchors exist, trust the singer's local measured tempo (75% local / 25% global).
      // When only 1 anchor exists, blend natural vocal tempo (60%) with global track budget (40%)
      // so long instrumental outros or bridges don't artificially stretch the immediate next verses!
      const effectiveSecPerWeight = anchoredIndices.length >= 2
        ? (latestObservedSecPerWeight * 0.75 + globalSecPerWeight * 0.25)
        : (NATURAL_SEC_PER_WEIGHT * 0.60 + globalSecPerWeight * 0.40);

      const projectedEnd = Math.min(
        dur - 1.5,
        Math.max(lastAnchorTime + 1.0, lastAnchorTime + remainingWeight * effectiveSecPerWeight)
      );

      interpolateUnitsSpan(units, lastAnchorIdx, units.length - 1, lastAnchorTime, projectedEnd);
      units[lastAnchorIdx].time = Math.round(lastAnchorTime * 100) / 100;
    }
  }

  /**
   * Perform Monotonic Forced Alignment (Viterbi / DTW) between known lyric lines,
   * timed ASR candidates, and optional saved/user anchors.
   */
  function alignLyrics(plainText, durationSeconds, asrSegments = [], customAnchors = null) {
    const { phoneticSimilarity } = window.YTMLyrics.Phonetics;
    const dur = (durationSeconds && durationSeconds > 30) ? durationSeconds : 180;
    const units = buildPhoneticLineUnits(plainText);
    if (units.length === 0) {
      return { lines: [], mode: 'AUTO-SYNC', anchorCount: 0 };
    }

    const introDefault = Math.min(15, Math.max(5.5, dur * 0.08));
    const outroDefault = Math.min(15, Math.max(6, dur * 0.08));
    const maxSingingEnd = Math.max(introDefault + 20, dur - outroDefault);

    const candidates = buildASRCandidates(asrSegments);
    let anchorCount = 0;

    if (candidates.length > 0) {
      const firstVocalTime = candidates[0].time;
      let lastMatchedTime = Math.max(0.5, firstVocalTime - 0.5);

      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        const expectedRatio = i / Math.max(1, units.length - 1);
        const expectedTime = introDefault + expectedRatio * (maxSingingEnd - introDefault);

        let bestScore = 0;
        let bestTime = null;

        for (const cand of candidates) {
          if (cand.time < lastMatchedTime + 0.35) continue;
          if (cand.time > dur - 2) break;

          const timeDiff = Math.abs(cand.time - expectedTime);
          if (timeDiff > dur * 0.35) continue;

          const sim = phoneticSimilarity(unit.text, cand.text);
          const timePenalty = (timeDiff / dur) * 0.25;
          const score = sim - timePenalty;

          if (sim >= 0.46 && score > bestScore) {
            bestScore = score;
            bestTime = cand.time;
          }
        }

        if (bestTime !== null) {
          unit.anchorTime = bestTime;
          lastMatchedTime = bestTime;
          anchorCount++;
        }
      }

      if (units[0].anchorTime === null && firstVocalTime >= 1.0 && firstVocalTime <= 28.0) {
        if (units.length < 2 || !units[1].anchorTime || firstVocalTime < units[1].anchorTime) {
          units[0].anchorTime = firstVocalTime;
          anchorCount++;
        }
      }
    }

    // Apply any saved or interactive multi-anchors on top
    if (customAnchors && typeof customAnchors === 'object') {
      const entries = Object.entries(customAnchors)
        .map(([k, v]) => [Number(k), Number(v)])
        .filter(([idx, t]) => Number.isInteger(idx) && idx >= 0 && idx < units.length && t >= 0)
        .sort((a, b) => a[0] - b[0]);

      for (const [idx, t] of entries) {
        units[idx].anchorTime = t;
        anchorCount++;
      }
    }

    solvePiecewiseWithLocalTempo(units, dur, introDefault, maxSingingEnd);

    const lines = units.map(u => ({
      time: u.time,
      text: u.text,
      isAnchored: u.anchorTime !== null,
      lineWeight: u.lineWeight,
      pauseWeightBefore: u.pauseWeightBefore
    }));

    return {
      lines,
      mode: anchorCount > 0 ? 'FORCED-ALIGN' : 'AUTO-SYNC',
      anchorCount
    };
  }

  /**
   * Multi-Anchor Incremental Viterbi Re-Alignment:
   * Accumulates user anchors across the song (instead of discarding previous anchors),
   * enforces monotonic consistency, learns the singer's local tempo between anchors,
   * and returns the updated lines + sanitized anchors map.
   */
  function realignFromUserAnchor(plainText, anchorIndex, currentAudioTime, durationSeconds, existingAnchors = {}) {
    const dur = (durationSeconds && durationSeconds > 30) ? durationSeconds : 180;
    const units = buildPhoneticLineUnits(plainText);
    if (units.length === 0 || anchorIndex < 0 || anchorIndex >= units.length) {
      return { lines: [], anchors: existingAnchors || {} };
    }

    const clampedAnchorTime = Math.round(Math.max(0.2, currentAudioTime) * 100) / 100;
    const updatedAnchors = {};

    // Keep previous anchors that remain strictly monotonic with the newly clicked anchor
    if (existingAnchors && typeof existingAnchors === 'object') {
      for (const [rawIdx, rawTime] of Object.entries(existingAnchors)) {
        const idx = Number(rawIdx);
        const t = Number(rawTime);
        if (!Number.isInteger(idx) || idx < 0 || idx >= units.length || Number.isNaN(t)) continue;
        if (idx === anchorIndex) continue;
        if (idx < anchorIndex && t <= clampedAnchorTime - 0.35) {
          updatedAnchors[idx] = t;
        } else if (idx > anchorIndex && t >= clampedAnchorTime + 0.35) {
          updatedAnchors[idx] = t;
        }
      }
    }

    updatedAnchors[anchorIndex] = clampedAnchorTime;

    for (const [rawIdx, rawTime] of Object.entries(updatedAnchors)) {
      units[Number(rawIdx)].anchorTime = Number(rawTime);
    }

    const introDefault = Math.min(15, Math.max(5.5, dur * 0.08));
    const outroDefault = Math.min(14, Math.max(5, dur * 0.075));
    const maxSingingEnd = Math.max(introDefault + 20, dur - outroDefault);

    solvePiecewiseWithLocalTempo(units, dur, introDefault, maxSingingEnd);

    const lines = units.map((u, idx) => ({
      time: u.time,
      text: u.text,
      isAnchored: Object.prototype.hasOwnProperty.call(updatedAnchors, idx),
      lineWeight: u.lineWeight,
      pauseWeightBefore: u.pauseWeightBefore
    }));

    return {
      lines,
      anchors: updatedAnchors
    };
  }

  /**
   * Real-time Acoustic VAD coupling for plain/predicted lyrics:
   * 1. Holds line 0 during long instrumental intros until the first vocal onset is detected.
   * 2. Freezes advancement to the next lyric line during instrumental bridges/requintos when no voice is active.
   * 3. Snaps the upcoming line when a vocal phrase onset is detected right after a pause.
   */
  function applyLiveVADNudge(parsedLyrics, activeIndex, currentAudioTime, vadState, userAnchors = {}) {
    if (!vadState || !vadState.isSignalAvailable || !Array.isArray(parsedLyrics) || parsedLyrics.length === 0) {
      return false;
    }

    // 1. Intro Vocal Hold: If we haven't detected the first vocal yet and line 0 is not user-anchored,
    // prevent line 0 from activating during a pure instrumental intro (up to 50s).
    if (!vadState.hasDetectedFirstVocal && !vadState.isVocalActive && !userAnchors[0]) {
      if (currentAudioTime < 50 && currentAudioTime >= parsedLyrics[0].time - 0.25) {
        const pushDelta = (currentAudioTime + 0.45) - parsedLyrics[0].time;
        if (pushDelta > 0.05) {
          shiftUnanchoredLinesFrom(parsedLyrics, 0, pushDelta, userAnchors);
          return true;
        }
      }
      return false;
    }

    // 2. First Vocal Onset Snap: When the singer enters for the first time,
    // anchor line 0 cleanly and taper the adjustment instead of shifting the entire song rigidly.
    if (vadState.triggeredPhraseOnset && vadState.firstVocalOnsetTime !== null && activeIndex <= 2 && !userAnchors[0]) {
      const onsetDelta = vadState.firstVocalOnsetTime - parsedLyrics[0].time;
      if (Math.abs(onsetDelta) >= 0.3 && Math.abs(onsetDelta) <= 22.0) {
        const taperCount = Math.min(parsedLyrics.length, 6);
        for (let i = 0; i < taperCount; i++) {
          if (Object.prototype.hasOwnProperty.call(userAnchors, i)) break;
          const weight = 1 - (i / taperCount);
          const minPrev = i > 0 ? (parsedLyrics[i - 1].time + 0.35) : 0.2;
          const nextFixed = (i + 1 < parsedLyrics.length && i + 1 === taperCount)
            ? parsedLyrics[i + 1].time - 0.35
            : Infinity;
          const shifted = Math.min(nextFixed, Math.max(minPrev, parsedLyrics[i].time + onsetDelta * weight));
          parsedLyrics[i].time = Math.round(shifted * 100) / 100;
        }
        return true;
      }
    }

    // 3. Instrumental / Requinto Freeze: Only freeze advancement when the singer has been silent
    // for >= 1.8s (a true instrumental solo/bridge, NOT a normal ~1s breath between verses).
    const nextIdx = activeIndex + 1;
    if (nextIdx >= 0 && nextIdx < parsedLyrics.length && !userAnchors[nextIdx]) {
      const timeUntilNext = parsedLyrics[nextIdx].time - currentAudioTime;

      if (!vadState.isVocalActive && vadState.silenceDurationSec >= 1.8 && timeUntilNext <= 0.22 && timeUntilNext >= -0.6) {
        const holdDelta = (currentAudioTime + 0.30) - parsedLyrics[nextIdx].time;
        if (holdDelta > 0.02) {
          shiftUnanchoredLinesFrom(parsedLyrics, nextIdx, holdDelta, userAnchors);
          return true;
        }
      }

      // 4. Phrase Re-Entry Snap: When the singer's voice returns after a pause/bridge,
      // if the next line was scheduled slightly ahead (up to +2.8s), snap it to the vocal onset!
      if (vadState.triggeredPhraseOnset && timeUntilNext > 0.25 && timeUntilNext <= 2.8) {
        const snapDelta = currentAudioTime - parsedLyrics[nextIdx].time;
        shiftUnanchoredLinesFrom(parsedLyrics, nextIdx, snapDelta, userAnchors);
        return true;
      }
    }

    return false;
  }

  /**
   * Shift unanchored lines starting at `startIndex` by `deltaSec`,
   * tapering smoothly if there is a locked user anchor further ahead.
   */
  function shiftUnanchoredLinesFrom(parsedLyrics, startIndex, deltaSec, userAnchors = {}) {
    // Find if there is a future locked anchor
    let nextLockedAnchorIdx = -1;
    for (let i = startIndex; i < parsedLyrics.length; i++) {
      if (Object.prototype.hasOwnProperty.call(userAnchors, i)) {
        nextLockedAnchorIdx = i;
        break;
      }
    }

    if (nextLockedAnchorIdx === -1) {
      for (let i = startIndex; i < parsedLyrics.length; i++) {
        const minPrev = i > 0 ? (parsedLyrics[i - 1].time + 0.35) : 0.2;
        parsedLyrics[i].time = Math.round(Math.max(minPrev, parsedLyrics[i].time + deltaSec) * 100) / 100;
      }
    } else if (nextLockedAnchorIdx > startIndex) {
      const span = nextLockedAnchorIdx - startIndex;
      for (let i = startIndex; i < nextLockedAnchorIdx; i++) {
        const factor = 1 - ((i - startIndex) / span);
        const minPrev = i > 0 ? (parsedLyrics[i - 1].time + 0.3) : 0.2;
        const maxNext = parsedLyrics[nextLockedAnchorIdx].time - (nextLockedAnchorIdx - i) * 0.3;
        const shifted = parsedLyrics[i].time + deltaSec * factor;
        parsedLyrics[i].time = Math.round(Math.min(maxNext, Math.max(minPrev, shifted)) * 100) / 100;
      }
    }
  }

  /**
   * Match a live Whisper Tiny transcript snippet (spanning [windowStartTime..windowEndTime])
   * against the song's plain lyrics using phonetic bigram similarity in a monotonic neighborhood.
   * When matched, locks an automatic ASR anchor and re-solves upcoming lines with local tempo learning.
   */
  function alignFromWhisperTranscript(
    plainText,
    transcriptText,
    windowStartTime,
    windowEndTime,
    currentActiveIndex,
    durationSeconds,
    existingAnchors = {}
  ) {
    const { phoneticSimilarity } = window.YTMLyrics.Phonetics;
    const units = buildPhoneticLineUnits(plainText);
    if (!units.length || !transcriptText || transcriptText.trim().length < 4) {
      return { matched: false };
    }

    const words = transcriptText.trim().split(/\s+/).filter(Boolean);
    if (words.length < 2) {
      return { matched: false };
    }

    // Build sliding sub-phrases from the transcript with fractional temporal positions
    const phrases = [{ text: transcriptText.trim(), startRatio: 0 }];
    for (let i = 0; i < words.length; i++) {
      let chunk = '';
      for (let len = 1; len <= 10 && (i + len) <= words.length; len++) {
        chunk += (len > 1 ? ' ' : '') + words[i + len - 1];
        if (len >= 2) {
          phrases.push({
            text: chunk,
            startRatio: i / Math.max(1, words.length)
          });
        }
      }
    }

    const dur = (durationSeconds && durationSeconds > 30) ? durationSeconds : 180;
    const anchorCount = Object.keys(existingAnchors || {}).length;
    const expectedLineByTime = Math.floor((windowStartTime / dur) * units.length);
    const centerIdx = currentActiveIndex >= 0 ? currentActiveIndex : expectedLineByTime;

    // Search a monotonic window around the current/expected line to prevent jumping to repeated choruses
    const searchStart = Math.max(0, centerIdx - (anchorCount > 0 ? 3 : 6));
    const searchEnd = Math.min(units.length - 1, centerIdx + (anchorCount > 0 ? 12 : 18));

    let bestLineIdx = -1;
    let bestScore = 0;
    let bestSim = 0;
    let bestStartRatio = 0;

    for (let i = searchStart; i <= searchEnd; i++) {
      const unit = units[i];
      // Skip very short ad-libs ("Uh", "Wuh") that cause false phonetic matches
      if (unit.text.length < 6) continue;

      const distPenalty = Math.abs(i - centerIdx) * 0.012;

      for (const phrase of phrases) {
        const sim = phoneticSimilarity(unit.text, phrase.text);
        const score = sim - distPenalty;
        if (sim >= 0.44 && score > bestScore) {
          bestScore = score;
          bestSim = sim;
          bestLineIdx = i;
          bestStartRatio = phrase.startRatio;
        }
      }
    }

    if (bestLineIdx === -1) {
      return { matched: false };
    }

    const windowSpan = Math.max(0.6, windowEndTime - windowStartTime);
    const estimatedLineTime = Math.round((windowStartTime + bestStartRatio * windowSpan) * 100) / 100;

    const result = realignFromUserAnchor(
      plainText,
      bestLineIdx,
      estimatedLineTime,
      dur,
      existingAnchors
    );

    return {
      matched: true,
      matchedIndex: bestLineIdx,
      matchedLine: units[bestLineIdx].text,
      matchedTime: estimatedLineTime,
      similarity: Math.round(bestSim * 100) / 100,
      lines: result.lines,
      anchors: result.anchors
    };
  }

  window.YTMLyrics.ForcedAlignment = {
    buildPhoneticLineUnits,
    alignLyrics,
    realignFromUserAnchor,
    applyLiveVADNudge,
    alignFromWhisperTranscript
  };
})();
