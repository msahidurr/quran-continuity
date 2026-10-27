/*
 * Message types exchanged between the popup and the content script, and the playback states
 * the content script reports.
 */
(function (root) {
  'use strict';

  const MSG = Object.freeze({
    GET_STATUS: 'qc:get-status',
    NEXT_SURAH: 'qc:next-surah',
    STOP_AUTOPLAY: 'qc:stop-autoplay',
    RESUME_AUTOPLAY: 'qc:resume-autoplay',
    STATUS_CHANGED: 'qc:status-changed',
    SPEAK: 'qc:speak',
    STOP_SPEAKING: 'qc:stop-speaking',
  });

  const STATE = Object.freeze({
    IDLE: 'idle',
    PLAYING: 'playing',
    PAUSED: 'paused',
    TRANSITIONING: 'transitioning',
    ERROR: 'error',
  });

  const api = { MSG, STATE };
  const QC = (root.QC = root.QC || {});
  QC.messages = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
