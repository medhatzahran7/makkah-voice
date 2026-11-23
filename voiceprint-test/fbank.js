/* Voiceprint feature extraction — Kaldi-style log Mel filterbank (fbank)
 * Mirrors torchaudio.compliance.kaldi.fbank as used by WeSpeaker training:
 *   16 kHz, 80 mel bins, 25 ms frame, 10 ms shift, Hamming window,
 *   pre-emphasis 0.97, dither 0 (deterministic at inference), use_energy=false.
 * Optional CMVN: subtract per-bin mean over time (WeSpeaker training applies
 * apply_cmvn with norm_mean=true). Whether CMVN helps at inference is decided
 * empirically — see verify/verify.js.
 *
 * Works in Node (module.exports) and in the browser (window.Voiceprint).
 * Pure JS, no dependencies. All processing is client-side.
 */
var Voiceprint = (function () {
  'use strict';

  var SAMPLE_RATE = 16000;
  var NUM_MEL_BINS = 80;
  var FRAME_LEN = 400;   // 25 ms @16kHz
  var FRAME_SHIFT = 160; // 10 ms @16kHz
  var FFT_SIZE = 512;
  var PREEMPH = 0.97;

  // Iterative radix-2 FFT (in-place, real+imag arrays). n must be a power of 2.
  function fft(re, im) {
    var n = re.length, j = 0, i, k, m, t;
    for (i = 1; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (i = 0; i < n; i += len) {
        var cwr = 1, cwi = 0;
        for (k = 0; k < len / 2; k++) {
          var ur = re[i + k], ui = im[i + k];
          var vr = re[i + k + len / 2] * cwr - im[i + k + len / 2] * cwi;
          var vi = re[i + k + len / 2] * cwi + im[i + k + len / 2] * cwr;
          re[i + k] = ur + vr; im[i + k] = ui + vi;
          re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          var nwr = cwr * wr - cwi * wi;
          cwi = cwr * wi + cwi * wr; cwr = nwr;
        }
      }
    }
  }

  function melFreq(f) { return 2595 * Math.log10(1 + f / 700); }
  function hzFromMel(m) { return 700 * (Math.pow(10, m / 2595) - 1); }

  // 80 triangular mel filters, Kaldi style. Returns Float32Array(80 * 257).
  function melBanks() {
    var numFftBins = FFT_SIZE / 2;               // 256
    var fftBinWidth = SAMPLE_RATE / FFT_SIZE;     // 31.25 Hz
    var lowFreq = 20, highFreq = SAMPLE_RATE / 2; // 8000
    var melLow = melFreq(lowFreq), melHigh = melFreq(highFreq);
    var n = NUM_MEL_BINS + 2;
    var melPoints = new Float64Array(n);
    for (var i = 0; i < n; i++) melPoints[i] = melLow + (melHigh - melLow) * i / (n - 1);
    var fftBins = new Int32Array(n);
    for (i = 0; i < n; i++) {
      fftBins[i] = Math.floor((FFT_SIZE + 1) * hzFromMel(melPoints[i]) / SAMPLE_RATE);
    }
    var banks = new Float32Array(NUM_MEL_BINS * (numFftBins + 1));
    for (i = 0; i < NUM_MEL_BINS; i++) {
      var left = fftBins[i], center = fftBins[i + 1], right = fftBins[i + 2];
      for (var j = left; j < center; j++) {
        if (j >= 0 && j <= numFftBins) banks[i * (numFftBins + 1) + j] = (j - left) / (center - left);
      }
      for (j = center; j < right; j++) {
        if (j >= 0 && j <= numFftBins) banks[i * (numFftBins + 1) + j] = (right - j) / (right - center);
      }
    }
    return banks;
  }

  var BANKS = null;
  var HAMMING = null;
  function hamming() {
    if (HAMMING) return HAMMING;
    HAMMING = new Float64Array(FRAME_LEN);
    for (var n = 0; n < FRAME_LEN; n++) {
      HAMMING[n] = 0.54 - 0.46 * Math.cos(2 * Math.PI * n / (FRAME_LEN - 1));
    }
    return HAMMING;
  }

  /* pcm: Float32Array of mono samples at 16 kHz, values in [-1, 1].
   * opts.cmvn: boolean — subtract per-bin time mean (default false).
   * Returns { data: Float32Array(frames*80), frames: number, dim: 80 }. */
  function computeFbank(pcm, opts) {
    opts = opts || {};
    if (!BANKS) BANKS = melBanks();
    var win = hamming();
    var n = pcm.length;
    // scale to int16 range (WeSpeaker: waveform * (1<<15))
    var x = new Float64Array(n);
    for (var i = 0; i < n; i++) x[i] = pcm[i] * 32768;
    // pre-emphasis 0.97
    for (i = n - 1; i >= 1; i--) x[i] -= PREEMPH * x[i - 1];
    // frames
    var numFrames = n >= FRAME_LEN ? 1 + Math.floor((n - FRAME_LEN) / FRAME_SHIFT) : 1;
    var feats = new Float32Array(numFrames * NUM_MEL_BINS);
    var re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE);
    var numFftBins = FFT_SIZE / 2;
    for (var f = 0; f < numFrames; f++) {
      var start = f * FRAME_SHIFT;
      re.fill(0); im.fill(0);
      for (var s = 0; s < FRAME_LEN; s++) {
        var idx = start + s;
        re[s] = (idx < n ? x[idx] : 0) * win[s];
      }
      fft(re, im);
      // power spectrum |X|^2 (bins 0..256), then mel energies
      for (var m = 0; m < NUM_MEL_BINS; m++) {
        var e = 0;
        var base = m * (numFftBins + 1);
        for (var b = 0; b <= numFftBins; b++) {
          var w = BANKS[base + b];
          if (w !== 0) e += w * (re[b] * re[b] + im[b] * im[b]);
        }
        feats[f * NUM_MEL_BINS + m] = Math.log(Math.max(e, 1e-10));
      }
    }
    if (opts.cmvn) {
      for (var d = 0; d < NUM_MEL_BINS; d++) {
        var mean = 0;
        for (f = 0; f < numFrames; f++) mean += feats[f * NUM_MEL_BINS + d];
        mean /= numFrames;
        for (f = 0; f < numFrames; f++) feats[f * NUM_MEL_BINS + d] -= mean;
      }
    }
    return { data: feats, frames: numFrames, dim: NUM_MEL_BINS };
  }

  function cosine(a, b) {
    var dot = 0, na = 0, nb = 0;
    for (var i = 0; i < a.length; i++) {
      dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
  }

  function l2norm(a) {
    var n = 0;
    for (var i = 0; i < a.length; i++) n += a[i] * a[i];
    n = Math.sqrt(n) || 1;
    var out = new Float32Array(a.length);
    for (i = 0; i < a.length; i++) out[i] = a[i] / n;
    return out;
  }

  // Average embeddings, then L2-normalize (voiceprint for one speaker).
  function averageEmbeddings(list) {
    var dim = list[0].length;
    var avg = new Float32Array(dim);
    for (var i = 0; i < list.length; i++) {
      for (var j = 0; j < dim; j++) avg[j] += list[i][j];
    }
    for (var j = 0; j < dim; j++) avg[j] /= list.length;
    return l2norm(avg);
  }

  return {
    SAMPLE_RATE: SAMPLE_RATE,
    computeFbank: computeFbank,
    cosine: cosine,
    l2norm: l2norm,
    averageEmbeddings: averageEmbeddings
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Voiceprint;
if (typeof window !== 'undefined') window.Voiceprint = Voiceprint;
