(() => {
  'use strict';

  const API = 'https://wte-cloud-api.onrender.com';
  const SESSION_KEY = 'wte_conversion_session';
  const VISITOR_KEY = 'wte_conversion_visitor';

  function randomId(prefix) {
    const value = crypto.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}_${value}`;
  }

  function getId(key, prefix, storage) {
    try {
      let value = storage.getItem(key);
      if (!value) {
        value = randomId(prefix);
        storage.setItem(key, value);
      }
      return value;
    } catch {
      return randomId(prefix);
    }
  }

  const visitorId = getId(VISITOR_KEY, 'visitor', localStorage);
  const sessionId = getId(SESSION_KEY, 'session', sessionStorage);

  function safeMetadata(input = {}) {
    const output = {};
    for (const [key, value] of Object.entries(input || {})) {
      // Explicitly reject likely PII keys.
      if (/name|email|phone|address|location/i.test(key)) continue;

      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        output[key] =
          typeof value === 'string' ? value.slice(0, 200) : value;
      }
    }
    return output;
  }

  function buildPayload(eventName, metadata) {
    return {
      eventName,
      sessionId,
      visitorId,
      path: location.pathname,
      referrerHost: (() => {
        try {
          return document.referrer
            ? new URL(document.referrer).hostname
            : '';
        } catch {
          return '';
        }
      })(),
      metadata: safeMetadata(metadata),
      occurredAt: new Date().toISOString()
    };
  }

  function track(eventName, metadata = {}) {
    if (!eventName) return;

    const body = JSON.stringify(buildPayload(eventName, metadata));
    const url = `${API}/api/public/analytics/event`;

    try {
      if (navigator.sendBeacon) {
        const sent = navigator.sendBeacon(
          url,
          new Blob([body], { type: 'application/json' })
        );
        if (sent) return;
      }
    } catch {}

    fetch(url, {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body
    }).catch(() => {});
  }

  window.WTEAnalytics = Object.freeze({
    track,
    sessionId,
    visitorId
  });

  track('page_view', {
    release:
      document.querySelector('meta[name="wte-release"]')?.content || ''
  });
})();
