// ============================================================
// إرسال الطلبات الجديدة إلى تيليجرام في رسالة واحدة مجمّعة
// يقارن jobs.json الحالي مع قائمة الأرقام (IDs) اللي أُرسلت قبل
// بنجاح فعلي، ويبني رسالة وحدة فيها كل الطلبات الجديدة
// ============================================================

const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const JOBS_PATH = path.join(__dirname, 'docs', 'jobs.json');
const NOTIFIED_PATH = path.join(__dirname, 'docs', 'notified-ids.json');
const MAX_KEEP = 1000;
const DESC_MAX_LEN = 150;
const TELEGRAM_MAX_LEN = 4000; // حد تيليجرام 4096، نترك هامش أمان

(async () => {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('لا يوجد TELEGRAM_BOT_TOKEN أو TELEGRAM_CHAT_ID — تأكد من إضافتهم في Secrets.');
    process.exit(1);
  }

  if (!fs.existsSync(JOBS_PATH)) {
    console.log('ملف jobs.json غير موجود بعد — لسا ما اشتغل السحب الأول.');
    return;
  }

  const jobsData = JSON.parse(fs.readFileSync(JOBS_PATH, 'utf-8'));
  const jobs = jobsData.jobs || [];

  let notifiedIds = [];
  if (fs.existsSync(NOTIFIED_PATH)) {
    try {
      notifiedIds = JSON.parse(fs.readFileSync(NOTIFIED_PATH, 'utf-8')).ids || [];
    } catch (e) {
      notifiedIds = [];
    }
  }
  const notifiedSet = new Set(notifiedIds);

  const newJobs = jobs.filter((job) => !notifiedSet.has(job.id));

  if (newJobs.length === 0) {
    console.log('لا توجد طلبات جديدة منذ آخر إشعار.');
    return;
  }

  console.log(`بناء رسالة مجمّعة لـ ${newJobs.length} طلب جديد...`);

  const header = '📋 <b>هذه آخر الطلبات المنشورة في خمسات:</b>\n';
  const blocks = [];

  for (const job of newJobs) {
    const descLine = job.description
      ? '\n' + escapeHtml(truncate(job.description, DESC_MAX_LEN))
      : '';
    const block =
      `\n🎨 <b>${escapeHtml(job.title)}</b>\n` +
      `🕒 ${escapeHtml(job.age || 'غير معروف')}` +
      descLine +
      `\n🔗 <a href="${job.url}">فتح الطلب</a>`;
    blocks.push(block);
  }

  // نبني الرسالة ونقسّمها لأكثر من رسالة لو تجاوزت حد تيليجرام
  const messages = [];
  let current = header;
  for (const block of blocks) {
    if ((current + '\n➖➖➖\n' + block).length > TELEGRAM_MAX_LEN) {
      messages.push(current);
      current = header + block;
    } else {
      current += (current === header ? '' : '\n➖➖➖\n') + block;
    }
  }
  if (current.trim()) messages.push(current);

  let allSucceeded = true;
  for (const msg of messages) {
    const ok = await sendTelegramMessage(msg);
    if (!ok) allSucceeded = false;
  }

  if (allSucceeded) {
    console.log(`تم إرسال ${newJobs.length} طلب بنجاح ضمن ${messages.length} رسالة.`);
    const updatedIds = [...notifiedIds, ...newJobs.map((j) => j.id)].slice(-MAX_KEEP);
    fs.writeFileSync(NOTIFIED_PATH, JSON.stringify({ ids: updatedIds }, null, 2), 'utf-8');
  } else {
    console.log('فشل إرسال جزء من الرسائل — راح يعاد المحاولة في التشغيل الجاي.');
  }

  async function sendTelegramMessage(text) {
    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: text,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });
      const result = await res.json();
      if (!result.ok) {
        console.log('فشل إرسال رسالة: ' + JSON.stringify(result));
        return false;
      }
      return true;
    } catch (err) {
      console.log('خطأ شبكة أثناء الإرسال: ' + err.message);
      return false;
    }
  }
})();

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(str, max) {
  if (str.length <= max) return str;
  return str.slice(0, max).trim() + '…';
}
