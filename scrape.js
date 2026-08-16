// ============================================================
// سحب وفلترة طلبات التصميم من خمسات
// - يستخدم متصفح حقيقي (headless Chrome) لتجاوز حماية AWS WAF
// - يقرأ الوقت الدقيق من خاصية title المخفية بكل عنصر (GMT كامل)
//   بدل تخمين النص العربي التقريبي — أدق بكثير
// - يفلتر: كلمات مفتاحية للتصميم + عمر الطلب أقل من 24 ساعة
// - يرتب من الأحدث للأقدم حسب وقت الإنشاء الفعلي
// - يجيب وصف كل طلب مطابق من صفحته التفصيلية (article.replace_urls)
// ============================================================

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');

const KEYWORDS = [
  'تصميم', 'شعار', 'لوجو', 'بانر', 'غلاف', 'سوشيال ميديا',
  'انفوجرافيك', 'بروشور', 'فلاير', 'إعلان', 'ثمبنيل',
  'هوية بصرية', 'كتالوج', 'بطاقة عمل', 'بوستر', 'موشن جرافيك'
];

const SOURCE_URL = 'https://khamsat.com/community/requests';
const MAX_AGE_MINUTES = 24 * 60;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// يحوّل "14/08/2026 20:57:51 GMT" إلى epoch milliseconds (UTC)
function parseGmtTitle(str) {
  if (!str) return null;
  const m = str.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min, ss] = m;
  return Date.UTC(
    parseInt(yyyy, 10),
    parseInt(mm, 10) - 1,
    parseInt(dd, 10),
    parseInt(hh, 10),
    parseInt(min, 10),
    parseInt(ss, 10)
  );
}

function formatAge(minutes) {
  if (minutes === null || minutes === undefined) return 'غير معروف';
  if (minutes < 1) return 'أقل من دقيقة';
  if (minutes < 60) return 'منذ ' + minutes + ' دقيقة';
  if (minutes < 1440) return 'منذ ' + Math.floor(minutes / 60) + ' ساعة';
  return 'منذ ' + Math.floor(minutes / 1440) + ' يوم';
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8' });

  console.log('فتح صفحة الطلبات...');
  await page.goto(SOURCE_URL, { waitUntil: 'networkidle2', timeout: 60000 });

  try {
    await page.waitForSelector('tr.forum_post', { timeout: 25000 });
  } catch (e) {
    console.log('تحذير: ما لقيت صفوف طلبات بعد الانتظار.');
  }

  // نستخرج العنوان والرابط والوقت الدقيق (GMT) مباشرة من كل صف
  const rawJobs = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr.forum_post'));
    const results = [];

    rows.forEach((row) => {
      const link = row.querySelector('h3.details-head a.ajaxbtn');
      if (!link) return;

      const href = link.getAttribute('href') || '';
      const idMatch = href.match(/\/community\/requests\/(\d+)-/);
      if (!idMatch) return;

      const title = (link.textContent || '').trim();
      if (!title) return;

      // وقت الإنشاء الأصلي (مو آخر تفاعل) — العنصر المرئي بالديسكتوب
      const timeSpan = row.querySelector('li.d-lg-inline-block.d-none span[title]');
      const dateTitle = timeSpan ? timeSpan.getAttribute('title') : '';

      results.push({
        id: parseInt(idMatch[1], 10),
        title: title,
        url: link.href,
        dateTitle: dateTitle
      });
    });

    return results;
  });

  console.log(`إجمالي الطلبات في الصفحة: ${rawJobs.length}`);

  const jobs = rawJobs.map((job) => {
    const epoch = parseGmtTitle(job.dateTitle);
    const minutesAgo = epoch === null ? null : Math.round((Date.now() - epoch) / 60000);
    return { ...job, minutesAgo: Math.max(0, minutesAgo) };
  });

  let filtered = jobs.filter((job) => KEYWORDS.some((kw) => job.title.includes(kw)));
  console.log(`مطابق للكلمات المفتاحية: ${filtered.length}`);

  filtered = filtered.filter((job) => job.minutesAgo === null || job.minutesAgo <= MAX_AGE_MINUTES);

  filtered.sort((a, b) => {
    const aMin = a.minutesAgo === null ? 999999 : a.minutesAgo;
    const bMin = b.minutesAgo === null ? 999999 : b.minutesAgo;
    return aMin - bMin;
  });

  // نجيب وصف كل طلب مطابق من صفحته التفصيلية
  for (const job of filtered) {
    try {
      await page.goto(job.url, { waitUntil: 'networkidle2', timeout: 30000 });
      const description = await page.evaluate(() => {
        const el = document.querySelector('article.replace_urls');
        return el ? el.textContent.trim() : '';
      });
      job.description = description;
    } catch (e) {
      job.description = '';
    }
  }

  await browser.close();

  const output = {
    updatedAt: new Date().toISOString(),
    totalFound: rawJobs.length,
    matched: filtered.length,
    jobs: filtered.map((job) => ({
      id: job.id,
      title: job.title,
      url: job.url,
      age: formatAge(job.minutesAgo),
      description: job.description || ''
    }))
  };

  const outDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'jobs.json'), JSON.stringify(output, null, 2), 'utf-8');

  console.log(`تم. إجمالي: ${rawJobs.length}, مطابق (تصميم + أقل من 24 ساعة): ${filtered.length}`);
})();
