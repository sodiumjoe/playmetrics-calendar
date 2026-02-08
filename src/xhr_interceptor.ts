(function () {
  const PM_API = 'api.playmetrics.com';

  const dispatch = (eventName: string, data: Record<string, unknown>) => {
    window.dispatchEvent(
      new CustomEvent(eventName, { detail: JSON.stringify(data) })
    );
  };

  function extractAuthToken(headers: Record<string, string>): { firebaseToken: string; accessKey: string } | null {
    let firebaseToken: string | null = null;
    let accessKey: string | null = null;
    for (const [key, value] of Object.entries(headers)) {
      const lower = key.toLowerCase();
      if (lower === 'firebase-token' && value) firebaseToken = value;
      if (lower === 'pm-access-key' && value) accessKey = value;
    }
    if (firebaseToken && accessKey) return { firebaseToken, accessKey };
    return null;
  }

  function isPlayMetricsApi(url: string): boolean {
    try {
      return new URL(url).hostname === PM_API;
    } catch {
      return url.includes(PM_API);
    }
  }

  function isCalendarEndpoint(url: string): boolean {
    return isPlayMetricsApi(url) && url.includes('/user/calendars');
  }

  const AVAILABILITY_RE = /\/(practices|games)\/(\d+)\/availability\/(\d+)/;
  const CALENDAR_EVENT_AVAILABILITY_RE = /\/teams\/\d+\/calendar_events\/(\d+)\/availability\/(\d+)/;

  function parseAvailabilityUrl(url: string): { eventType: 'practice' | 'game' | 'calendar_event'; eventId: number; playerId: number } | null {
    if (!isPlayMetricsApi(url)) return null;
    const ceMatch = url.match(CALENDAR_EVENT_AVAILABILITY_RE);
    if (ceMatch) {
      return {
        eventType: 'calendar_event',
        eventId: Number(ceMatch[1]),
        playerId: Number(ceMatch[2]),
      };
    }
    const match = url.match(AVAILABILITY_RE);
    if (!match) return null;
    return {
      eventType: match[1] === 'practices' ? 'practice' : 'game',
      eventId: Number(match[2]),
      playerId: Number(match[3]),
    };
  }

  function processRequest(
    method: string,
    url: string,
    requestHeaders: Record<string, string>,
    requestBody: string | null,
    status: number,
    responseBody: string | null,
  ) {
    if (!isPlayMetricsApi(url)) return;

    const auth = extractAuthToken(requestHeaders);
    if (auth) {
      dispatch('playmetrics-auth-token', auth);
    }

    if (method === 'GET' && isCalendarEndpoint(url) && responseBody) {
      try {
        const data = JSON.parse(responseBody);
        dispatch('playmetrics-calendar-data', { data });
      } catch {
        // ignore malformed responses
      }
    }

    const availability = parseAvailabilityUrl(url);
    if (availability && (method === 'PUT' || method === 'POST')) {
      let response = null;
      if (responseBody) {
        try {
          response = JSON.parse(responseBody);
        } catch {
          // ignore
        }
      }
      dispatch('playmetrics-attendance-update', {
        eventType: availability.eventType,
        eventId: availability.eventId,
        playerId: availability.playerId,
        status: response?.status ?? null,
        response,
      });
    }
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args: Parameters<typeof fetch>) {
    const [input, init] = args;
    const request = new Request(input, init);
    const method = request.method;
    const url = request.url;

    if (!isPlayMetricsApi(url)) {
      return originalFetch.apply(this, args);
    }

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (init?.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(init.headers)) {
        for (const [key, value] of init.headers) {
          headers[key] = value;
        }
      } else {
        for (const [key, value] of Object.entries(init.headers)) {
          headers[key] = value;
        }
      }
    }

    let requestBody: string | null = null;
    if (init?.body) {
      try {
        requestBody =
          typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      } catch {
        requestBody = null;
      }
    }

    const response = await originalFetch.apply(this, args);
    const clone = response.clone();
    let responseBody: string | null = null;
    try {
      responseBody = await clone.text();
    } catch {
      responseBody = null;
    }
    processRequest(method, url, headers, requestBody, response.status, responseBody);
    return response;
  };

  interface XhrMeta {
    method: string;
    url: string;
    headers: Record<string, string>;
  }

  const xhrMeta = new WeakMap<XMLHttpRequest, XhrMeta>();

  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;
  const XHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    xhrMeta.set(this, { method, url: String(url), headers: {} });
    return XHROpen.call(this, method, url, async ?? true, username ?? null, password ?? null);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (
    name: string,
    value: string,
  ) {
    const meta = xhrMeta.get(this);
    if (meta) {
      meta.headers[name] = value;
    }
    return XHRSetRequestHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const meta = xhrMeta.get(this);

    if (meta && !isPlayMetricsApi(meta.url)) {
      return XHRSend.call(this, body);
    }

    let requestBody: string | null = null;
    if (body) {
      try {
        requestBody = typeof body === 'string' ? body : String(body);
      } catch {
        requestBody = null;
      }
    }

    this.addEventListener('load', function () {
      if (meta) {
        processRequest(
          meta.method,
          meta.url,
          meta.headers,
          requestBody,
          this.status,
          this.responseText,
        );
      }
    });

    return XHRSend.call(this, body);
  };
})();