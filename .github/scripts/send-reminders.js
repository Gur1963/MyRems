// MyRems - send-reminders.js
// גרסה: V1-WEBPUSH-13082026
// רץ כל 15 דקות (דרך cron-job.org -> workflow_dispatch, אותו דפוס כמו ב-MyLists).
// בודק את כל המשתמשים ב-collection 'rems_users', ולכל פריט תזכורת בודק אם הגיע זמן
// אחד מזמני ההתראה שנבחרו לו (item.reminderOffsets), ושולח Web Push ישירות למנוי
// (item.pushSubscription) שנשמר בדפדפן של אותו משתמש - בלי צורך בשירות ntfy חיצוני.
// פריטים עם item.repeat (daily/weekly/monthly/yearly) משוכפלים אוטומטית לתאריך הבא
// ברגע שהם מסתיימים.

const admin = require('firebase-admin');
const webpush = require('web-push');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// ממיר תאריך+שעה כפי שהוזנו (לפי שעון ישראל) לזמן UTC אמיתי,
// כולל טיפול אוטומטי במעבר שעון קיץ/חורף. (זהה ל-MyLists)
function israelToUtc(dateStr, timeStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  dtf.formatToParts(new Date(guess)).forEach(p => { parts[p.type] = p.value; });
  const asUtcOfLocal = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  const offset = asUtcOfLocal - guess;
  return new Date(guess - offset);
}

function offsetLabel(hours) {
  if (Math.abs(hours - 168) < 0.01) return 'שבוע לפני';
  if (Math.abs(hours - 72)  < 0.01) return '3 ימים לפני';
  if (Math.abs(hours - 24)  < 0.01) return 'יום לפני';
  if (Math.abs(hours - 12)  < 0.01) return 'חצי יום לפני';
  if (Math.abs(hours - 2)   < 0.01) return 'שעתיים לפני';
  if (Math.abs(hours - 1)   < 0.01) return 'שעה לפני';
  if (Math.abs(hours - 0.5) < 0.01) return 'חצי שעה לפני';
  if (Math.abs(hours) < 0.01) return 'בדיוק בזמן הפגישה';
  if (hours < 1) return `${Math.round(hours * 60)} דקות לפני`;
  return `${hours} שעות לפני`;
}

// מחשבת את התאריך הבא לפריט חוזר (daily/weekly/monthly/yearly), כולל הצמדה לסוף החודש
// כשהיום המקורי לא קיים בחודש היעד (למשל 31 בינואר -> 28/29 בפברואר).
function toDateStr(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function addMonthsToDate(y, m, d, monthsToAdd) {
  const totalMonths = (y * 12 + (m - 1)) + monthsToAdd;
  const targetY = Math.floor(totalMonths / 12);
  const targetM = (totalMonths % 12) + 1;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetY, targetM, 0)).getUTCDate();
  const targetD = Math.min(d, lastDayOfTargetMonth);
  return toDateStr(targetY, targetM, targetD);
}
function advanceDate(dateStr, repeat) {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (repeat === 'daily') {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 1);
    return toDateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  if (repeat === 'weekly') {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 7);
    return toDateStr(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  if (repeat === 'monthly') return addMonthsToDate(y, m, d, 1);
  if (repeat === 'yearly')  return addMonthsToDate(y, m, d, 12);
  return null;
}
function buildNextOccurrence(item) {
  const nextDate = advanceDate(item.date, item.repeat);
  if (!nextDate) return null;
  return {
    text: item.text,
    location: item.location,
    date: nextDate,
    time: item.time,
    done: false,
    reminderOffsets: item.reminderOffsets,
    notifiedOffsets: [],
    repeat: item.repeat,
  };
}

async function sendPush(subscription, item, offsetText) {
  const dateLabel = new Date(item.date + 'T00:00:00').toLocaleDateString('he-IL', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  let body = `בתאריך ${dateLabel} בשעה ${item.time} יש לך פגישה עם ${item.text}`;
  if (item.location) body += ` (${item.location})`;
  const title = offsetText ? `🔔 תזכורת לפגישה (${offsetText})` : '🔔 תזכורת לפגישה';

  const payload = JSON.stringify({ title, body, url: './index.html', tag: `myrems-${item.date}-${item.time}` });

  try {
    await webpush.sendNotification(subscription, payload);
  } catch (e) {
    // מנוי שפג תוקפו / נמחק בצד הדפדפן (410 Gone / 404) - לא נחשב שגיאה קריטית,
    // רק אומר שהמכשיר הזה כבר לא רשום. נזרוק הלאה כדי שהקורא יוכל לנקות את הרשומה.
    throw e;
  }
}

async function main() {
  const now = new Date();
  const usersSnap = await db.collection('rems_users').get();
  let sentCount = 0;
  let skippedNoSub = 0;

  for (const userDoc of usersSnap.docs) {
    const data = userDoc.data();
    if (!Array.isArray(data.items) || !data.items.length) continue;

    const subscription = data.pushSubscription;
    let changed = false;
    let subscriptionInvalid = false;
    const newOccurrences = [];

    for (const item of data.items) {
      if (item.done) continue;
      if (!item.date || !item.time) continue;

      const when = israelToUtc(item.date, item.time);
      const diffHours = (when - now) / 3600000;
      const offsets = (item.reminderOffsets && item.reminderOffsets.length) ? item.reminderOffsets : [24];
      const notifiedOffsets = Array.isArray(item.notifiedOffsets) ? item.notifiedOffsets : [];

      for (const offset of offsets) {
        const alreadySent = notifiedOffsets.some(o => Math.abs(o - offset) < 0.01);
        if (alreadySent) continue;
        // offset=0 ("בדיוק בזמן הפגישה") הוא מקרה מיוחד: מספיק שהגיע/עבר זמן הפגישה,
        // בלי לדרוש שנשאר זמן חיובי (אחרת זה לעולם לא יתקיים).
        const shouldSend = offset > 0 ? (diffHours <= offset && diffHours > 0) : (diffHours <= 0);
        if (!shouldSend) continue;

        if (!subscription) {
          skippedNoSub++;
          continue; // אין מנוי Push שמור למשתמש הזה - אין לאן לשלוח
        }
        try {
          console.log(`שולח תזכורת (${offsetLabel(offset)}): "${item.text}" (${item.date} ${item.time})`);
          await sendPush(subscription, item, offsetLabel(offset));
          notifiedOffsets.push(offset);
          changed = true;
          sentCount++;
        } catch (e) {
          const status = e && e.statusCode;
          if (status === 404 || status === 410) {
            // המנוי כבר לא תקף (המשתמש ביטל הרשאה / החליף מכשיר) - מנקים אותו
            subscriptionInvalid = true;
            console.log(`מנוי לא תקף למשתמש ${userDoc.id} - ינוקה`);
          } else {
            console.log(`שגיאת שליחה למשתמש ${userDoc.id}: ${e.message}`);
          }
        }
      }

      item.notifiedOffsets = notifiedOffsets;
      const allSent = offsets.every(offset => notifiedOffsets.some(o => Math.abs(o - offset) < 0.01));
      if (allSent || diffHours <= 0) {
        item.done = true;
        changed = true;
        if (item.repeat && item.repeat !== 'none') {
          const next = buildNextOccurrence(item);
          if (next) {
            newOccurrences.push(next);
            console.log(`פריט חוזר (${item.repeat}): "${item.text}" - נוצר עותק חדש לתאריך ${next.date}`);
          }
        }
      }
    }

    if (newOccurrences.length) {
      data.items.push(...newOccurrences);
      changed = true;
    }
    if (subscriptionInvalid) {
      data.pushSubscription = null;
      changed = true;
    }
    if (changed) {
      await userDoc.ref.set(data);
    }
  }

  console.log(`סיום. נשלחו ${sentCount} התראות. (${skippedNoSub} פספוסים בגלל היעדר מנוי Push)`);
}

main().catch(err => {
  console.error('שגיאה כללית:', err);
  process.exit(1);
});
