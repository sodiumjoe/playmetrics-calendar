const script = document.createElement('script');
script.src = chrome.runtime.getURL('xhr_interceptor.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

const EVENT_MAP: Record<string, string> = {
  'playmetrics-auth-token': 'AUTH_TOKEN',
  'playmetrics-calendar-data': 'CALENDAR_DATA',
  'playmetrics-attendance-update': 'ATTENDANCE_UPDATE',
};

for (const [eventName, messageType] of Object.entries(EVENT_MAP)) {
  window.addEventListener(eventName, (event: Event) => {
    const customEvent = event as CustomEvent<string>;
    let payload: unknown;
    try {
      payload = JSON.parse(customEvent.detail);
    } catch {
      return;
    }
    chrome.runtime.sendMessage({ type: messageType, payload });
  });
}