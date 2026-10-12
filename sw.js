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

// ── חידוש מנוי ברקע ──────────────────────────────────────────────────────
// הדפדפן מודיע כאן כשהוא מחליף/מבטל את מנוי ה-Push (גם כשהאפליקציה סגורה).
// נרשמים מחדש ושומרים את המנוי החדש בענן, כדי שההתראות לא ייעצרו עד הפתיחה
// הבאה של האפליקציה. זה "מאמץ מיטבי" בלבד (לא כל דפדפן שולח את האירוע, והשמירה
// נשענת על פרטי ההתחברות ש-Firebase Auth שומר ב-IndexedDB) - אם משהו כאן נכשל,
// הגיבוי הוא syncPushSubscription ב-index.html, שרץ בכל פתיחה של האפליקציה.
const FIREBASE_API_KEY = 'AIzaSyB4g5PzhJfyMXfXlpDtbaMkheESumDOWqw';
const FIRESTORE_DOCS = 'https://firestore.googleapis.com/v1/projects/mylist-96189/databases/(default)/documents';
const VAPID_PUBLIC_KEY = 'BHHrEpyuZlT2kcWxCAX_nkR6X2NExR7N15YbbteUXoLr-b7M9FMrMEA3Ogd6XLDkFF4s_jRu2_XATR-nt5ksYkw';

// המשתמש המחובר, כפי ש-Firebase Auth שומר אותו בדפדפן (uid + refresh token)
function readFirebaseAuthUser() {
  return new Promise((resolve) => {
    const req = indexedDB.open('firebaseLocalStorageDb');
    req.onupgradeneeded = () => req.transaction.abort(); // המאגר לא קיים - לא יוצרים אותו
    req.onerror = () => resolve(null);
    req.onsuccess = () => {
      const idb = req.result;
      try {
        const getAll = idb.transaction('firebaseLocalStorage', 'readonly')
          .objectStore('firebaseLocalStorage').getAll();
        getAll.onsuccess = () => {
          const rec = (getAll.result || []).find(r => String(r.fbase_key).startsWith('firebase:authUser:'));
          idb.close();
          resolve(rec ? rec.value : null);
        };
        getAll.onerror = () => { idb.close(); resolve(null); };
      } catch (e) {
        idb.close();
        resolve(null);
      }
    };
  });
}

async function saveSubscriptionToCloud(subscription, oldEndpoint) {
  const user = await readFirebaseAuthUser();
  const refreshToken = user && user.stsTokenManager && user.stsTokenManager.refreshToken;
  if (!user || !user.uid || !refreshToken) return;

  const tokenRes = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`,
  });
  if (!tokenRes.ok) return;
  const idToken = (await tokenRes.json()).id_token;
  const headers = { 'Authorization': `Bearer ${idToken}`, 'Content-Type': 'application/json' };
  const docUrl = `${FIRESTORE_DOCS}/rems_users/${user.uid}`;

  // יש מנוי אחד למשתמש: אם בענן שמור כרגע מנוי של מכשיר אחר - לא דורסים אותו
  if (oldEndpoint) {
    const curRes = await fetch(`${docUrl}?mask.fieldPaths=pushSubscription`, { headers });
    if (!curRes.ok) return;
    const cur = (await curRes.json()).fields;
    const curSub = cur && cur.pushSubscription && cur.pushSubscription.mapValue;
    const curEndpoint = curSub && curSub.fields && curSub.fields.endpoint && curSub.fields.endpoint.stringValue;
    if (curEndpoint && curEndpoint !== oldEndpoint) return;
  }

  const json = subscription.toJSON();
  const body = {
    fields: {
      pushSubscription: {
        mapValue: {
          fields: {
            endpoint: { stringValue: json.endpoint },
            expirationTime: json.expirationTime == null
              ? { nullValue: null }
              : { integerValue: String(json.expirationTime) },
            keys: {
              mapValue: {
                fields: {
                  p256dh: { stringValue: json.keys.p256dh },
                  auth: { stringValue: json.keys.auth },
                },
              },
            },
          },
        },
      },
    },
  };
  await fetch(`${docUrl}?updateMask.fieldPaths=pushSubscription&currentDocument.exists=true`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(body),
  });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        let sub = event.newSubscription || (await self.registration.pushManager.getSubscription());
        if (!sub) {
          sub = await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: VAPID_PUBLIC_KEY,
          });
        }
        await saveSubscriptionToCloud(sub, event.oldSubscription && event.oldSubscription.endpoint);
      } catch (e) {
        // לא קריטי - המנוי יחודש בפתיחה הבאה של האפליקציה
      }
    })()
  );
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
