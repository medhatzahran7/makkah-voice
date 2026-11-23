'use strict';
/**
 * keystore.js — Public key-bundle store for the Signal Protocol (Phase 2).
 *
 * Stores ONLY public keys, in memory, with periodic persistence to a local
 * JSON file (data/keybundles.json). Private keys are NEVER stored here:
 * any bundle containing a field whose name suggests a private key is
 * rejected outright.
 *
 * A bundle has the shape:
 *   {
 *     identityKey:  "<base64 X25519 public key>",
 *     signedPreKey: { id: <number>, key: "<base64>", signature: "<base64>" },
 *     oneTimePreKeys: [ { id: <number>, key: "<base64>" }, ... ]
 *   }
 * The server treats the bundle as opaque apart from shape validation —
 * it never inspects, decrypts or derives anything from the keys.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, 'data', 'keybundles.json');

// Hard limits so one client cannot bloat the store.
const MAX_ONE_TIME_PREKEYS = 100;
const MAX_KEY_B64_LEN = 512;

function isB64String(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_KEY_B64_LEN
    && /^[A-Za-z0-9+/=_-]+$/.test(v);
}

function containsPrivateKeyField(obj, depth) {
  if (depth > 4 || obj === null || typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    if (/private|secret|seed/i.test(k)) return true;
    if (containsPrivateKeyField(obj[k], depth + 1)) return true;
  }
  return false;
}

/**
 * Validate a key bundle's shape. Returns null when valid, else an error string.
 */
function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return 'bundle must be an object';
  }
  if (containsPrivateKeyField(bundle, 0)) {
    return 'private keys are never accepted';
  }
  if (!isB64String(bundle.identityKey)) {
    return 'identityKey must be a non-empty base64 string';
  }
  const spk = bundle.signedPreKey;
  if (!spk || typeof spk !== 'object'
    || typeof spk.id !== 'number'
    || !isB64String(spk.key)
    || !isB64String(spk.signature)) {
    return 'signedPreKey must be { id: number, key: base64, signature: base64 }';
  }
  if (bundle.oneTimePreKeys !== undefined) {
    if (!Array.isArray(bundle.oneTimePreKeys)
      || bundle.oneTimePreKeys.length > MAX_ONE_TIME_PREKEYS) {
      return 'oneTimePreKeys must be an array of at most ' + MAX_ONE_TIME_PREKEYS;
    }
    for (const opk of bundle.oneTimePreKeys) {
      if (!opk || typeof opk !== 'object'
        || typeof opk.id !== 'number' || !isB64String(opk.key)) {
        return 'each one-time prekey must be { id: number, key: base64 }';
      }
    }
  }
  return null;
}

class KeyStore {
  /**
   * @param {string} [filePath] JSON file used for persistence.
   */
  constructor(filePath) {
    this.filePath = filePath || DEFAULT_PATH;
    /** Map<towerId, { bundle, updatedAt }> */
    this.bundles = new Map();
    this._dirty = false;
    this._saveTimer = null;
    this._loadFromDisk();
  }

  _loadFromDisk() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!raw || typeof raw !== 'object') return;
      for (const [towerId, entry] of Object.entries(raw)) {
        if (typeof towerId !== 'string' || !entry || typeof entry !== 'object') continue;
        if (validateBundle(entry.bundle) === null) {
          this.bundles.set(towerId, {
            bundle: entry.bundle,
            updatedAt: entry.updatedAt || Date.now(),
          });
        }
      }
    } catch (err) {
      // Corrupt or unreadable file: start empty rather than crash.
      // The file is rewritten on the next save.
      console.error('[keystore] could not load %s: %s', this.filePath, err.message);
    }
  }

  _scheduleSave() {
    this._dirty = true;
    if (this._saveTimer) return;
    // Debounce: at most one disk write per second.
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 1000);
    // Do not keep the process alive just for a pending save.
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  saveNow() {
    if (!this._dirty) return;
    this._dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const out = {};
      for (const [towerId, entry] of this.bundles) {
        out[towerId] = { bundle: entry.bundle, updatedAt: entry.updatedAt };
      }
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(out, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.error('[keystore] could not save %s: %s', this.filePath, err.message);
      this._dirty = true; // retry on the next save trigger
    }
  }

  /**
   * Store (or replace) a tower's public key bundle.
   * @returns {null|string} null on success, error string on failure.
   */
  put(towerId, bundle) {
    if (typeof towerId !== 'string' || towerId.length === 0 || towerId.length > 128) {
      return 'towerId must be a non-empty string of at most 128 chars';
    }
    const err = validateBundle(bundle);
    if (err) return err;
    this.bundles.set(towerId, { bundle, updatedAt: Date.now() });
    this._scheduleSave();
    return null;
  }

  /** @returns {{ bundle, updatedAt } | null} */
  get(towerId) {
    return this.bundles.get(towerId) || null;
  }

  /** @returns {string[]} towerIds that have a stored bundle. */
  list() {
    return Array.from(this.bundles.keys());
  }

  /**
   * Remove one used one-time prekey after it has been handed out, so it is
   * never reused (Signal one-time prekeys are single-use). Returns the
   * removed prekey or null when none remain.
   */
  consumeOneTimePreKey(towerId) {
    const entry = this.bundles.get(towerId);
    if (!entry || !Array.isArray(entry.bundle.oneTimePreKeys)
      || entry.bundle.oneTimePreKeys.length === 0) return null;
    const used = entry.bundle.oneTimePreKeys.shift();
    this._scheduleSave();
    return used;
  }

  count() {
    return this.bundles.size;
  }
}

module.exports = { KeyStore, validateBundle };
