// ============================================================
// سحب وفلترة طلبات التصميم من خمسات
// - يستخدم متصفح حقيقي (headless Chrome) لتجاوز حماية AWS WAF
// - يقرأ الروابط والعناوين مباشرة من عناصر الصفحة (DOM) بدل تحليل
//   نص HTML يدوياً، عشان يشتغل سواء كانت الروابط كاملة أو نسبية
// - يفلتر: كلمات مفتاحية للتصميم + عمر الطلب أقل من 24 ساعة
// - يرتب من الأحدث للأقدم حسب وقت الإنشاء الفعلي
// - يجيب وصف كل طلب مطابق من صفحته التفصيلية
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

function parseArabicRelativeTime(text) {
  if (!text) return null;
  if (/أقل من دقيقة/.test(text)) return 0;

  let total = 0;
  const day = text.match(/(\d+)?\s*(يوم|يومين|أيام)/);
  if (day) total += (day[1] ? parseInt(day[1], 10) : (day[2] === 'يومين' ? 2 : 1)) * 1440;

  const hour = text.match(/(\d+)?\s*(ساعة|ساعتين|ساعات)/);
  if (hour) total += (hour[1] ? parseInt(hour[1], 10) : (hour[2] === 'ساعتين' ? 2 : 1)) * 60;

  const min = text.match(/(\d+)?\s*(دقيقة|دقيقتين|دقائق)/);
  if (min) total += (min[1] ? parseInt(min[1], 10) : (min[2] === 'دقيقتين' ? 2 : 1));

  return total;
}

function extractAgeText(contextText) {
  if (!contextText) return '';
  const lines = contextText.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (line.includes('منذ') && !line.includes('آخر تفاعل')) {
      return line.replace('منذ', '').trim();
    }
  }
  for (const line of lines) {
    if (line.includes('أقل من دقيقة')) return 'أقل من دقيقة';
  }
  return '';
}

function formatAge(minutes, fallbackText) {
  if (minutes === null || minutes === undefined) return fallbackText || 'غير معروف';
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
    await page.waitForSelector('a[href*="/community/requests/"]', { timeout: 25000 });
  } catch (e) {
    console.log('تحذير: ما لقيت روابط طلبات بعد الانتظار.');
  }

  const rawJobs = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll('a[href*="/community/requests/"]'));
    const seen = {};
    const results = [];

    anchors.forEach((a) => {
      const href = a.getAttribute('href') || '';
      const match = href.match(/\/community\/requests\/(\d+)-/);
      if (!match) return;
      const id = parseInt(match[1], 10);
      if (seen[id]) return;

      const title = (a.textContent || '').trim();
      if (!title) return;
      seen[id] = true;

      let container = a.parentElement;
      let contextText = '';
      for (let i = 0; i < 3 && container; i++) {
        contextText = container.innerText || '';
        if (contextText.includes('منذ')) break;
        container = container.parentElement;
      }

      results.push({
        id: id,
        title: title,
        url: a.href,
        contextText: contextText.slice(0, 400)
      });
    });

    return results;
  });

  const jobs = rawJobs.map((job) => {
    const ageText = extractAgeText(job.contextText);
    const minutesAgo = parseArabicRelativeTime(ageText);
    return {
      id: job.id,
      title: job.title,
      url: job.url,
      ageText: ageText,
      minutesAgo: minutesAgo
    };
  });

  let filtered = jobs.filter((job) => KEYWORDS.some((kw) => job.title.includes(kw)));
  filtered = filtered.filter((job) => job.minutesAgo === null || job.minutesAgo <= MAX_AGE_MINUTES);

  filtered.sort((a, b) => {
    const aMin = a.minutesAgo === null ? 999999 : a.minutesAgo;
    const bMin = b.minutesAgo === null ? 999999 : b.minutesAgo;
    return aMin - bMin;
  });

  for (const job of filtered) {
    try {
      await page.goto(job.url, { waitUntil: 'networkidle2', timeout: 30000 });
      const desc = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        if (!h1) return '';
        let el = h1.nextElementSibling;
        let hops = 0;
        while (el && hops < 15) {
          const text = (el.innerText || '').trim();
          if (text.length > 25) return text.slice(0, 500);
          el = el.nextElementSibling;
          hops++;
        }
        return '';
      });
      job.description = desc;
    } catch (e) {
      job.description = '';
    }
  }

  await browser.close();

  const output = {
    updatedAt: new Date().toISOString(),
    totalFound: jobs.length,
    matched: filtered.length,
    jobs: filtered.map((job) => ({
      id: job.id,
      title: job.title,
      url: job.url,
      age: formatAge(job.minutesAgo, job.ageText),
      description: job.description || ''
    }))
  };

  const outDir = path.join(__dirname, 'docs');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'jobs.json'), JSON.stringify(output, null, 2), 'utf-8');

  console.log(`تم. إجمالي: ${jobs.length}, مطابق (تصميم + أقل من 24 ساعة): ${filtered.length}`);
})();
