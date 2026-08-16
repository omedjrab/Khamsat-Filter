// ============================================================
// سحب وفلترة طلبات التصميم من خمسات
// - يستخدم متصفح حقيقي (headless Chrome) لتجاوز حماية AWS WAF
// - يفلتر بالكلمات المفتاحية من صفحة القائمة
// - يزور صفحة كل طلب مطابق ليجيب الوقت والوصف بدقة أعلى
// - بعدين يفلتر الطلبات الأقدم من 24 ساعة ويرتب من الأحدث للأقدم
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

  if (total === 0 && !day && !hour && !min) return null;
  return total;
}

function extractAgeFromRaw(raw) {
  if (!raw) return '';
  const idx = raw.indexOf('منذ');
  if (idx === -1) return '';
  return raw.slice(idx + 3, idx + 3 + 40).trim();
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

  const rawJobs =
