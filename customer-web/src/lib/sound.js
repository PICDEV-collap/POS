'use client';

// Order-event notification sounds, synthesized with Web Audio (no audio
// assets, works offline on the in-store LAN). Two distinct chimes:
//   - new order  → double "ding-dong" doorbell (attention, kitchen-loud)
//   - paid       → rising C-major "cha-ching" arpeggio (success)
// Browsers block audio until a user gesture, so the AudioContext is unlocked
// lazily from pointer/key events (installAudioUnlock) and when the user
// flips the sound toggle.

import { useEffect, useRef, useState } from 'react';
import { ensureSocketConnected } from './socket';
import { storageGet, storageSet } from './browser';

const SOUND_KEY = 'pos_v2_sound_enabled';
// Ignore socket events older than this — the realtime layer replays missed
// events after reconnect/reload; stale replays must not re-announce.
const FRESH_WINDOW_MS = 3 * 60 * 1000;

// Spoken Thai phrases (used by the TTS fallback and as the recorded clips).
const PHRASE_NEW_ORDER = 'รับออเดอร์';
const PHRASE_PAYMENT = 'ขอบคุณครับ';
const PHRASE_CALL = 'เรียกเก็บเงิน';

// Bundled voice clips (customer-web/public/sounds/*.mp3) — the PRIMARY
// announcement. Works on every browser/device, offline, no OS voice needed.
// TTS and the chime are fallbacks if a clip can't play.
const CLIP_NEW_ORDER = '/sounds/new-order.mp3';
const CLIP_PAYMENT = '/sounds/payment.mp3';
const CLIP_CALL = '/sounds/call-staff.mp3';

let _ctx = null;
let _unlockInstalled = false;
let _voicesWarmed = false;
const _clips = {};

export function soundEnabled() {
  return storageGet(SOUND_KEY) !== '0'; // default: on
}

export function setSoundEnabled(on) {
  storageSet(SOUND_KEY, on ? '1' : '0');
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pos:sound-changed'));
  }
}

function audioCtx() {
  if (typeof window === 'undefined') return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!_ctx) {
    try { _ctx = new AC(); } catch { return null; }
  }
  return _ctx;
}

export function unlockAudio() {
  const ctx = audioCtx();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// One-time global listeners: the first tap/keypress anywhere unlocks audio.
// Listeners stay attached — iOS can re-suspend the context, and resuming an
// already-running context is a no-op.
export function installAudioUnlock() {
  if (_unlockInstalled || typeof window === 'undefined') return;
  _unlockInstalled = true;
  warmUpVoices();
  warmClips();
  const unlock = () => { unlockAudio(); warmUpVoices(); warmClips(); };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);
}

function tone(ctx, { at = 0, freq = 880, dur = 0.3, type = 'sine', gain = 0.25 }) {
  const t0 = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015); // fast attack, no click
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); // natural decay
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

// ─── Spoken announcements (primary) ───────────────────────────────────
// Staff hears a short attention chime followed by a Thai phrase. If the
// device has no Thai TTS voice, the chime alone is the notification — we do
// NOT let an English engine mangle the Thai text.

function pickThaiVoice() {
  if (typeof speechSynthesis === 'undefined') return null;
  const voices = speechSynthesis.getVoices() || [];
  return voices.find((v) => /^th([-_]|$)/i.test(v.lang || ''))
      || voices.find((v) => /thai|ไทย/i.test(v.name || ''))
      || null;
}

// getVoices() is empty until the speech engine finishes loading; prime it
// early and on change so a voice is ready by the time the first order lands.
function warmUpVoices() {
  if (typeof speechSynthesis === 'undefined' || _voicesWarmed) return;
  _voicesWarmed = true;
  try {
    speechSynthesis.getVoices();
    speechSynthesis.addEventListener?.('voiceschanged', () => { speechSynthesis.getVoices(); });
  } catch {}
}

// Speak `text` in Thai. Returns false if no Thai voice is available so the
// caller can decide on a fallback.
export function speak(text) {
  if (typeof speechSynthesis === 'undefined' || !text || !soundEnabled()) return false;
  const voice = pickThaiVoice();
  if (!voice) return false;
  try {
    speechSynthesis.cancel();   // don't pile up if orders burst in
    speechSynthesis.resume();   // some engines park in a paused state
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang || 'th-TH';
    u.rate = 1.0;
    u.pitch = 1.0;
    u.volume = 1.0;
    speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

// Short attention chime played just before the spoken phrase (and the sole
// notification when no Thai voice exists).
function chime(kind) {
  const ctx = unlockAudio();
  if (!ctx || ctx.state !== 'running') return;
  if (kind === 'payment') {
    [523.25, 783.99, 1046.5].forEach((f, i) => {
      tone(ctx, { at: i * 0.08, freq: f, dur: 0.26, type: 'triangle', gain: 0.28 });
    });
  } else {
    tone(ctx, { at: 0, freq: 987.77, dur: 0.22, type: 'triangle', gain: 0.4 });
    tone(ctx, { at: 0.2, freq: 783.99, dur: 0.3, type: 'triangle', gain: 0.4 });
  }
}

// Play a bundled clip. Returns true if playback was started; on async failure
// (autoplay blocked / load error) it invokes onFail so the caller falls back.
function playClip(url, onFail) {
  if (typeof Audio === 'undefined') return false;
  try {
    let a = _clips[url];
    if (!a) { a = new Audio(url); a.preload = 'auto'; _clips[url] = a; }
    a.currentTime = 0;
    a.volume = 1;
    const p = a.play();
    if (p && typeof p.then === 'function') p.catch(() => { if (onFail) onFail(); });
    return true;
  } catch {
    return false;
  }
}

// Preload the clips so the first real order plays instantly.
function warmClips() {
  if (typeof Audio === 'undefined') return;
  for (const url of [CLIP_NEW_ORDER, CLIP_PAYMENT]) {
    if (!_clips[url]) { const a = new Audio(url); a.preload = 'auto'; _clips[url] = a; }
  }
}

// Announce an event: recorded clip → Thai TTS → chime, in order of preference.
function announce(clipUrl, phrase, chimeKind) {
  const fallback = () => { if (!speak(phrase)) chime(chimeKind); };
  if (!playClip(clipUrl, fallback)) fallback();
}

// New order → "รับออเดอร์"
export function playNewOrderSound() {
  if (!soundEnabled()) return;
  unlockAudio();
  announce(CLIP_NEW_ORDER, PHRASE_NEW_ORDER, 'new');
  try { navigator.vibrate?.([150, 90, 150]); } catch {}
}

// Payment received → "ขอบคุณครับ"
export function playPaymentSound() {
  if (!soundEnabled()) return;
  unlockAudio();
  announce(CLIP_PAYMENT, PHRASE_PAYMENT, 'payment');
  try { navigator.vibrate?.(120); } catch {}
}

// Customer called staff / requested bill → "เรียกเก็บเงิน"
export function playCallStaff() {
  if (!soundEnabled()) return;
  unlockAudio();
  announce(CLIP_CALL, PHRASE_CALL, 'new');
  try { navigator.vibrate?.([200, 100, 200]); } catch {}
}

function eventTs(value) {
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Listen for customer "call staff / request bill" (`table:call`) events, ring
// the call announcement, and hand each call to `onCall` for UI (e.g. a banner).
// Same socket attach/re-attach pattern as useOrderSounds. Store-filtered and
// freshness-gated so stale replays after reconnect don't re-ring.
export function useTableCalls(onCall, { storeId = null } = {}) {
  const onCallRef = useRef(onCall);
  onCallRef.current = onCall;
  const optsRef = useRef({ storeId });
  optsRef.current = { storeId };

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    installAudioUnlock();

    let socket = null;
    const matchesStore = (payload) => {
      const want = Number(optsRef.current.storeId);
      if (!Number.isInteger(want) || want <= 0) return true;
      const got = Number(payload?.store_id);
      return !Number.isInteger(got) || got <= 0 || got === want;
    };
    const onEvt = (payload) => {
      if (!payload || !matchesStore(payload)) return;
      if (Date.now() - eventTs(payload.at) >= FRESH_WINDOW_MS) return;
      playCallStaff();
      try { onCallRef.current?.(payload); } catch { /* ignore */ }
    };
    const detach = () => {
      if (!socket) return;
      socket.off('table:call', onEvt);
      socket = null;
    };
    const attach = () => {
      const next = ensureSocketConnected();
      if (socket === next) return;
      detach();
      socket = next;
      socket.on('table:call', onEvt);
    };

    attach();
    const onChanged = () => attach();
    window.addEventListener('pos:socket-changed', onChanged);
    return () => {
      window.removeEventListener('pos:socket-changed', onChanged);
      detach();
    };
  }, []);
}

// Attach directly to the shared socket and ring on live order events.
// Follows the same attach/re-attach pattern as useRealtimeRecovery so it
// survives socket rebuilds. Dedupes per order id (covers replay + the
// double-delivery case where our own status PATCH also echoes back).
export function useOrderSounds({ storeId = null, newOrder = true, payment = true } = {}) {
  const seenRef = useRef({ created: new Set(), paid: new Set() });
  const optsRef = useRef({ storeId, newOrder, payment });
  optsRef.current = { storeId, newOrder, payment };

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    installAudioUnlock();

    let socket = null;

    const remember = (set, id) => {
      set.add(id);
      if (set.size > 300) set.delete(set.values().next().value);
    };
    const matchesStore = (payload) => {
      const want = Number(optsRef.current.storeId);
      if (!Number.isInteger(want) || want <= 0) return true;
      const got = Number(payload?.store_id);
      return !Number.isInteger(got) || got <= 0 || got === want;
    };
    const isFresh = (iso) => Date.now() - eventTs(iso) < FRESH_WINDOW_MS;

    const onNew = (order) => {
      if (!optsRef.current.newOrder || !order?.id) return;
      if (!matchesStore(order) || !isFresh(order.created_at)) return;
      if (seenRef.current.created.has(order.id)) return;
      remember(seenRef.current.created, order.id);
      playNewOrderSound();
    };
    const onUpdate = (order) => {
      if (!optsRef.current.payment || !order?.id) return;
      if (order.status !== 'paid') return;
      if (!matchesStore(order) || !isFresh(order.updated_at || order.created_at)) return;
      if (seenRef.current.paid.has(order.id)) return;
      remember(seenRef.current.paid, order.id);
      playPaymentSound();
    };

    const detach = () => {
      if (!socket) return;
      socket.off('order:new', onNew);
      socket.off('order:update', onUpdate);
      socket = null;
    };
    const attach = () => {
      const next = ensureSocketConnected();
      if (socket === next) return;
      detach();
      socket = next;
      socket.on('order:new', onNew);
      socket.on('order:update', onUpdate);
    };

    attach();
    const onSocketChanged = () => attach();
    window.addEventListener('pos:socket-changed', onSocketChanged);
    return () => {
      window.removeEventListener('pos:socket-changed', onSocketChanged);
      detach();
    };
  }, []);
}

// Topbar pill toggle. Turning sound ON announces the new-order phrase once —
// doubles as the unlock gesture (audio + speech) and previews what staff hear.
export function SoundToggleButton({ style = {} }) {
  const [on, setOn] = useState(true);
  useEffect(() => {
    setOn(soundEnabled());
    const sync = () => setOn(soundEnabled());
    window.addEventListener('pos:sound-changed', sync);
    return () => window.removeEventListener('pos:sound-changed', sync);
  }, []);
  const toggle = () => {
    const next = !soundEnabled();
    setSoundEnabled(next);
    setOn(next);
    if (next) {
      unlockAudio();
      playNewOrderSound();
    }
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label={on ? 'ปิดเสียงแจ้งเตือน' : 'เปิดเสียงแจ้งเตือน'}
      title={on ? 'ปิดเสียงแจ้งเตือน' : 'เปิดเสียงแจ้งเตือน'}
      style={{
        background: on ? 'rgba(15,185,140,.16)' : 'rgba(255,255,255,.08)',
        color: on ? '#0fb98c' : 'rgba(255,255,255,.6)',
        border: `1px solid ${on ? 'rgba(15,185,140,.35)' : 'rgba(255,255,255,.16)'}`,
        padding: '8px 13px', borderRadius: 999,
        fontSize: 12, fontWeight: 700, cursor: 'pointer',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {on ? '🔊 เสียงเปิด' : '🔇 เสียงปิด'}
    </button>
  );
}
