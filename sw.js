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

// לחיצה על ההתראה - פותחים/מביאים לחזית את האפליקציה.
// שימו לב: מנסים קודם openWindow (גם אם כבר יש טאב/אפליקציה פתוחה ברקע) ולא
// focus()/navigate() על קליינט קיים - כי בבדיקות בפועל התברר ש-focus() על טאב
// שכבר פתוח לא תמיד מצליח "לנצח" אפליקציה native אחרת שפעילה כרגע (כמו משחק),
// בעוד ש-openWindow הוכח כעובד באמינות בכל המקרים. עבור PWA מותקנת (WebAPK),
// openWindow על כתובת בתוך ה-scope שלה בדרך כלל רק מעלה לחזית את המופע הקיים
// במקום לפתוח כפילות.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './index.html';
  event.waitUntil(
    (async () => {
      if (self.clients.openWindow) {
        try {
          const opened = await self.clients.openWindow(targetUrl);
          if (opened) return;
        } catch (e) {
          // אם openWindow נכשל מסיבה כלשהי, ננסה בכל זאת גיבוי עם טאב קיים למטה
        }
      }
      const clientsArr = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clientsArr) {
        if ('focus' in client) {
          if ('navigate' in client) {
            try { await client.navigate(targetUrl); } catch (e) { /* לא קריטי אם נכשל */ }
          }
          return client.focus();
        }
      }
    })()
  );
});
