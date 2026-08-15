// ============================================================
// إرسال الطلبات الجديدة إلى تيليجرام
// يقارن jobs.json الحالي مع قائمة الأرقام (IDs) اللي أُرسلت قبل،
// ويبعت بس الجديد فعلاً: العنوان، وقت الإنشاء، والوصف
// ============================================================

const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const JOBS_PATH = path.join(__dirname, 'docs', 'jobs.json');
const NOTIFIED_PATH = path.join(__dirname, 'docs', 'notified-ids.json');
const MAX_KEEP = 1000;

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

  for (const job of newJobs) {
    const descLine = job.description
      ? '\n' + escapeHtml(truncate(job.description, 300))
      : '';
    const message =
      `🎨 <b>${escapeHtml(job.title)}</b>\n` +
      `🕒 ${escapeHtml(job.age || 'غير معروف')}` +
      descLine +
      `\n\n🔗 <a href="${job.url}">فتح الطلب</a>`;

    const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    const result = await res.json();
    if (!result.ok) {
      console.log('فشل إرسال رسالة للطلب ' + job.id + ':', JSON.stringify(result));
    }
  }

  console.log(`تم إرسال ${newJobs.length} طلب جديد إلى تيليجرام.`);

  const updatedIds = [...notifiedIds, ...newJobs.map((j) => j.id)].slice(-MAX_KEEP);
  fs.writeFileSync(NOTIFIED_PATH, JSON.stringify({ ids: updatedIds }, null, 2), 'utf-8');
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
