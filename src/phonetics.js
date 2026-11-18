/**
 * YTM Sync Lyrics - Phonetics & G2P (Grapheme-to-Phoneme) Module
 * Converts Spanish/English lyrics text into phonetic codes, syllable profiles,
 * and computes phonetic similarity for Forced Alignment (DTW / Viterbi).
 */

(() => {
  'use strict';

  window.YTMLyrics = window.YTMLyrics || {};

  /**
   * Convert text into a normalized phonetic code so ASR transcription variations
   * (e.g. "Aztteca" vs "Azteca", "pa'" vs "para", "b" vs "v", "s/c/z") match cleanly.
   */
  function toPhoneticCode(text) {
    if (!text) return '';
    return text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '') // Strip diacritics
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\bpa\b/g, 'para')
      .replace(/h/g, '')               // Silent 'h' in Spanish
      .replace(/qu/g, 'k')
      .replace(/c([ei])/g, 's$1')
      .replace(/c/g, 'k')
      .replace(/z/g, 's')
      .replace(/v/g, 'b')
      .replace(/ll/g, 'y')
      .replace(/([a-z])\1+/g, '$1')    // Collapse duplicate letters (e.g. "tt" -> "t")
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Extract phonetic features from a lyric line:
   * - syllableCount: number of vowel nuclei
   * - openVowels: count of open vowels (a, e, o) which carry longer sustained vocal formants
   * - durationWeight: expected relative singing duration in seconds
   */
  function analyzeLinePhonetics(text) {
    const clean = (text || '').trim();
    if (!clean) {
      return { syllableCount: 0, openVowels: 0, durationWeight: 0, phoneticCode: '' };
    }

    const vowelClusters = clean.match(/[aeiouáéíóúü]+/gi) || [];
    const openVowelMatches = clean.match(/[aeoáéó]+/gi) || [];
    const syllableCount = Math.max(1, vowelClusters.length);
    const openVowels = openVowelMatches.length;

    // Base phrase articulation + syllable time + open vowel sustain bonus
    const durationWeight = 1.25 + (syllableCount * 0.21) + (openVowels * 0.04);

    return {
      syllableCount,
      openVowels,
      durationWeight,
      phoneticCode: toPhoneticCode(clean)
    };
  }

  /**
   * Compute Dice's coefficient over character bigrams of phonetic codes (0.0 to 1.0).
   * Fast and resilient to partial word differences in noisy ASR outputs.
   */
  function phoneticSimilarity(textA, textB) {
    const codeA = toPhoneticCode(textA).replace(/\s+/g, '');
    const codeB = toPhoneticCode(textB).replace(/\s+/g, '');

    if (!codeA || !codeB) return 0;
    if (codeA === codeB) return 1;
    if (codeA.length < 2 || codeB.length < 2) {
      return codeA[0] === codeB[0] ? 0.5 : 0;
    }

    const bigramsA = new Map();
    for (let i = 0; i < codeA.length - 1; i++) {
      const bg = codeA.slice(i, i + 2);
      bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
    }

    let intersection = 0;
    for (let i = 0; i < codeB.length - 1; i++) {
      const bg = codeB.slice(i, i + 2);
      const count = bigramsA.get(bg) || 0;
      if (count > 0) {
        bigramsA.set(bg, count - 1);
        intersection++;
      }
    }

    return (2.0 * intersection) / ((codeA.length - 1) + (codeB.length - 1));
  }

  window.YTMLyrics.Phonetics = {
    toPhoneticCode,
    analyzeLinePhonetics,
    phoneticSimilarity
  };
})();
