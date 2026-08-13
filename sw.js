// Service Worker של MyRems - רץ ברקע (גם כשהאתר סגור) ותפקידו היחיד:
// להקשיב להתראות Push שמגיעות מהשרת, ולהציג אותן כהתראת מערכת.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// מגיעה התראת push מהשרת (send-reminders.js, דרך web-push + VAPID)
self.addEventListener('push', (event) => {
  let payload = { title: '🔔 תזכורת', body: 'יש לך תזכורת חדשה', url: './index.html' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (e) {
    // אם ההודעה הגיעה כטקסט רגיל ולא JSON - נשתמש בברירת המחדל
  }

  const options = {
    body: payload.body,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
    dir: 'rtl',
    lang: 'he',
    tag: payload.tag || 'myrems-reminder',
    data: { url: payload.url || './index.html' },
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

// לחיצה על ההתראה - פותחים/מביאים לחזית את האפליקציה
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientsArr) => {
      for (const client of clientsArr) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
