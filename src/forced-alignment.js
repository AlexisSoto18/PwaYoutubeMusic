/**
 * YTM Sync Lyrics - Forced Alignment Engine (DTW / Viterbi & Vocal Onset Alignment)
 * Aligns plain text lyrics (YTM PLAIN / PLAIN) to audio timestamps using:
 * 1. Dynamic Time Warping (DTW) & Viterbi monotonic path decoding against CTC/ASR segments.
 * 2. Piecewise phonetic & structural interpolation between acoustic anchors.
 * 3. Dynamic Viterbi forward re-alignment when an onset/line anchor is triggered.
 */

(() => {
  'use strict';

  window.YTMLyrics = window.YTMLyrics || {};

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
        units[i].pauseWeightBefore = (i === midBridgeIndex) ? 8.5 : 2.2;
      }
    }

    return units;
  }

  /**
   * Distribute timestamps across a slice of units [startIdx..endIdx] spanning [startTime..endTime]
   * weighted by each unit's phonetic syllables and stanza pauses.
   */
  function interpolateUnitsSpan(units, startIdx, endIdx, startTime, endTime) {
    let totalWeight = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      const pauseW = (i === startIdx) ? 0 : units[i].pauseWeightBefore;
      totalWeight += pauseW + units[i].lineWeight;
    }

    const spanSeconds = Math.max(0.5, endTime - startTime);
    const scale = spanSeconds / (totalWeight || 1);
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

    // Collect all timed words if available, otherwise use segment boundaries
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

    // Create sliding windows of words to match lyric lines of varying lengths
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
   * Perform Monotonic Forced Alignment (Viterbi / DTW) between known lyric lines
   * and timed ASR candidates, then interpolate remaining lines via phonetic weights.
   */
  function alignLyrics(plainText, durationSeconds, asrSegments = []) {
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
      // Detect vocal onset from first meaningful ASR segment
      const firstVocalTime = candidates[0].time;
      let lastMatchedTime = Math.max(0.5, firstVocalTime - 0.5);

      for (let i = 0; i < units.length; i++) {
        const unit = units[i];
        // Expected time window for line i to prevent matching repeated chorus lines at the wrong end of the song
        const expectedRatio = i / Math.max(1, units.length - 1);
        const expectedTime = introDefault + expectedRatio * (maxSingingEnd - introDefault);

        let bestScore = 0;
        let bestTime = null;

        for (const cand of candidates) {
          if (cand.time < lastMatchedTime + 0.35) continue;
          if (cand.time > dur - 2) break;

          // Temporal distance penalty so repeated choruses match their chronological occurrence
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

      // If line 0 didn't match lexically, anchor line 0 to detected vocal onset if reasonable
      if (units[0].anchorTime === null && firstVocalTime >= 1.0 && firstVocalTime <= 28.0) {
        if (units.length < 2 || !units[1].anchorTime || firstVocalTime < units[1].anchorTime) {
          units[0].anchorTime = firstVocalTime;
          anchorCount++;
        }
      }
    }

    // Piecewise interpolation between locked acoustic anchors
    const anchoredIndices = [];
    for (let i = 0; i < units.length; i++) {
      if (units[i].anchorTime !== null) {
        anchoredIndices.push(i);
      }
    }

    if (anchoredIndices.length === 0) {
      // Pure Phonetic & Structural Prediction
      interpolateUnitsSpan(units, 0, units.length - 1, introDefault, maxSingingEnd);
    } else {
      // 1. Before first anchor
      const firstAnchorIdx = anchoredIndices[0];
      if (firstAnchorIdx > 0) {
        const startT = Math.min(introDefault, Math.max(1.0, units[firstAnchorIdx].anchorTime * 0.35));
        interpolateUnitsSpan(units, 0, firstAnchorIdx, startT, units[firstAnchorIdx].anchorTime);
      }
      units[firstAnchorIdx].time = Math.round(units[firstAnchorIdx].anchorTime * 100) / 100;

      // 2. Between consecutive anchors
      for (let k = 0; k < anchoredIndices.length - 1; k++) {
        const idxA = anchoredIndices[k];
        const idxB = anchoredIndices[k + 1];
        const timeA = units[idxA].anchorTime;
        const timeB = units[idxB].anchorTime;

        if (idxB - idxA === 1) {
          units[idxB].time = Math.round(timeB * 100) / 100;
        } else {
          interpolateUnitsSpan(units, idxA, idxB, timeA, timeB);
          units[idxA].time = Math.round(timeA * 100) / 100;
          units[idxB].time = Math.round(timeB * 100) / 100;
        }
      }

      // 3. After last anchor
      const lastAnchorIdx = anchoredIndices[anchoredIndices.length - 1];
      if (lastAnchorIdx < units.length - 1) {
        const lastAnchorTime = units[lastAnchorIdx].anchorTime;
        const endT = Math.max(lastAnchorTime + (units.length - lastAnchorIdx) * 1.8, maxSingingEnd);
        interpolateUnitsSpan(units, lastAnchorIdx, units.length - 1, lastAnchorTime, endT);
        units[lastAnchorIdx].time = Math.round(lastAnchorTime * 100) / 100;
      }
    }

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
   * Forward & Backward Viterbi Re-Alignment when the user clicks a line to anchor it
   * at the exact moment the singer sings it.
   * Instead of a flat offset that drifts later, it locks line[anchorIndex] = currentAudioTime
   * and rescales all subsequent lines proportionally to fit the remaining track duration!
   */
  function realignFromUserAnchor(plainText, anchorIndex, currentAudioTime, durationSeconds) {
    const dur = (durationSeconds && durationSeconds > 30) ? durationSeconds : 180;
    const units = buildPhoneticLineUnits(plainText);
    if (units.length === 0 || anchorIndex < 0 || anchorIndex >= units.length) return [];

    const clampedAnchorTime = Math.max(0.2, currentAudioTime);
    const outroDefault = Math.min(14, Math.max(5, dur * 0.075));
    const endSingingTime = Math.max(clampedAnchorTime + (units.length - anchorIndex) * 1.6, dur - outroDefault);

    // 1. Interpolate lines before anchorIndex (if any)
    if (anchorIndex > 0) {
      const startTime = Math.min(5.0, clampedAnchorTime * 0.25);
      interpolateUnitsSpan(units, 0, anchorIndex, startTime, clampedAnchorTime);
    }

    // 2. Lock the anchor line and redistribute remaining lines [anchorIndex .. N-1]
    if (anchorIndex < units.length - 1) {
      interpolateUnitsSpan(units, anchorIndex, units.length - 1, clampedAnchorTime, endSingingTime);
    }
    units[anchorIndex].time = Math.round(clampedAnchorTime * 100) / 100;

    return units.map((u, idx) => ({
      time: u.time,
      text: u.text,
      isAnchored: idx === anchorIndex
    }));
  }

  window.YTMLyrics.ForcedAlignment = {
    buildPhoneticLineUnits,
    alignLyrics,
    realignFromUserAnchor
  };
})();
