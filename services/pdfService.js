// Copied and adapted from your existing server's services/pdfService.js
// Minor changes: aiColorService imported from local stub to avoid missing module errors
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { getDominantGradientColors, getMonochromaticGradient, generateDynamicGradient, selectMonochromaticPalette } from './aiColorService.js';

let cachedFontBase64 = null;
let cachedCoverFonts = null;
let cachedTemplates = {};

const BASE_CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-zygote',
  '--disable-accelerated-2d-canvas'
];

async function launchBrowserWithFallback(extraArgs = [], label = 'default') {
  const forcedExec = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
  const combinedArgs = Array.from(new Set([...BASE_CHROMIUM_ARGS, ...extraArgs]));
  try {
    console.log(`[PDFService] Trying chromium at ${forcedExec} (${label})`);
    const browser = await puppeteer.launch({
      executablePath: forcedExec,
      headless: 'new',
      args: combinedArgs
    });
    console.log(`[PDFService] Puppeteer launched with forced path (${label})`);
    return browser;
  } catch (e1) {
    console.warn(`[PDFService] Forced path failed for ${label} (${e1?.message}). Trying @sparticuz/chromium`);
    try {
      const chromiumArgs = Array.from(new Set([...(chromium.args || []), ...combinedArgs]));
      const browser = await puppeteer.launch({
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        args: chromiumArgs
      });
      console.log(`[PDFService] Puppeteer launched with @sparticuz/chromium (${label})`);
      return browser;
    } catch (e2) {
      console.warn(`[PDFService] Sparticuz failed for ${label} (${e2?.message}). Trying bundled Chromium`);
      const puppeteerRegular = await import('puppeteer');
      const browser = await puppeteerRegular.default.launch({
        headless: 'new',
        args: combinedArgs
      });
      console.log(`[PDFService] Puppeteer launched with bundled Chromium (${label})`);
      return browser;
    }
  }
}

async function getRemoteAssetSizeBytes(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const head = await fetch(url, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);
    const cl = head.headers.get('content-length');
    if (cl) return Number(cl);
  } catch {}
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { method: 'GET', headers: { 'range': 'bytes=0-1048575' }, signal: controller.signal });
    clearTimeout(timeout);
    const buf = Buffer.from(await res.arrayBuffer());
    const total = res.headers.get('content-length');
    return total ? Number(total) : buf.length;
  } catch {}
  return 0;
}

function getDataUrlSizeBytes(dataUrl) {
  try {
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return 0;
    const base64 = dataUrl.slice(commaIdx + 1);
    return Math.floor((base64.length * 3) / 4);
  } catch { return 0; }
}

function extractAssetUrlsFromHtml(html) {
  const urls = new Set();
  const srcRegex = /src=["']([^"']+)["']/g;
  const urlRegex = /url\(([^)]+)\)/g;
  let m;
  while ((m = srcRegex.exec(html)) !== null) {
    const u = m[1].replace(/^["']|["']$/g, '');
    if (u && !u.startsWith('data:')) urls.add(u);
  }
  while ((m = urlRegex.exec(html)) !== null) {
    let u = m[1].trim();
    if ((u.startsWith('"') && u.endsWith('"')) || (u.startsWith("'") && u.endsWith("'"))) {
      u = u.slice(1, -1);
    }
    if (u && !u.startsWith('data:')) urls.add(u);
  }
  const dataUrls = [];
  const dataRegex = /(src|href)=\s*["'](data:[^"']+)["']/g;
  while ((m = dataRegex.exec(html)) !== null) {
    dataUrls.push(m[2]);
  }
  const cssDataRegex = /url\((data:[^)]+)\)/g;
  while ((m = cssDataRegex.exec(html)) !== null) {
    dataUrls.push(m[1]);
  }
  return { urls: Array.from(urls), dataUrls };
}

async function logHtmlAssetWeights(label, html) {
  try {
    const { urls, dataUrls } = extractAssetUrlsFromHtml(html);
    const uniqueUrls = Array.from(new Set(urls));
    const results = [];
    for (const u of uniqueUrls) {
      const sz = await getRemoteAssetSizeBytes(u);
      results.push({ url: u, size: sz });
    }
    const dataResults = dataUrls.map(u => ({ url: u.slice(0, 80) + (u.length > 80 ? '...' : ''), size: getDataUrlSizeBytes(u), isDataUrl: true }));
    const total = results.reduce((a, b) => a + b.size, 0) + dataResults.reduce((a, b) => a + b.size, 0);
    console.log(`📦 Asset weights for ${label}:`);
    results.sort((a,b)=>b.size-a.size).slice(0, 20).forEach(r => console.log(`  • ${r.url} -> ${(r.size/1024/1024).toFixed(2)}MB`));
    if (dataResults.length) {
      console.log('📎 Inlined data URLs:');
      dataResults.sort((a,b)=>b.size-a.size).slice(0, 20).forEach(r => console.log(`  • ${r.url} -> ${(r.size/1024/1024).toFixed(2)}MB`));
    }
    console.log(`🧮 Total referenced assets ~ ${(total/1024/1024).toFixed(2)}MB`);
  } catch (e) {
    console.log('⚠️ Failed to log asset weights:', e?.message);
  }
}

function optimizeImageUrl(url, { width = 2400, quality = 90, fetchFormat = 'auto' } = {}) {
  try {
    if (!url || typeof url !== 'string') return url;
    const isCloudinary = /res\.cloudinary\.com\//.test(url);
    if (isCloudinary) {
      return url.replace(/\/upload\//, `/upload/f_${fetchFormat},q_${quality},w_${width}/`);
    }
    const isGoogleStorage = /storage\.googleapis\.com\//.test(url);
    if (isGoogleStorage) {
      return url;
    }
    return url;
  } catch (error) {
    console.error('Error optimizing image URL:', error);
    return url;
  }
}

function loadFontOnce() {
  if (cachedFontBase64 !== null) return cachedFontBase64;
  try {
    const possiblePaths = [
      path.resolve(process.cwd(), 'pdf-templates/pft_frank_bold-webfont.ttf'),
      path.resolve(process.cwd(), 'assets/fonts/pft_frank_bold-webfont.ttf'),
      path.resolve(process.cwd(), 'client/magic-book-client/src/fonts/pft_frank_bold-webfont.ttf'),
      path.resolve(process.cwd(), 'src/fonts/pft_frank_bold-webfont.ttf'),
      path.resolve(process.cwd(), 'fonts/pft_frank_bold-webfont.ttf')
    ];
    for (const fontPath of possiblePaths) {
      if (fs.existsSync(fontPath)) {
        cachedFontBase64 = fs.readFileSync(fontPath).toString('base64');
        break;
      }
    }
  } catch {}
  return cachedFontBase64;
}

function loadCoverFontsOnce() {
  if (cachedCoverFonts !== null) return cachedCoverFonts;
  try {
    const templatesDir = path.resolve(process.cwd(), 'pdf-templates');
    const fontFiles = {
      'FbSpacer-Bold_0.otf': 'FbSpacerBold',
      'FbSpacer-Black_0.otf': 'FbSpacerBlack',
      'FbSpacer-Regular_0.otf': 'SpacerRegular'
    };
    cachedCoverFonts = {};
    for (const [filename, fontFamily] of Object.entries(fontFiles)) {
      const fontPath = path.join(templatesDir, filename);
      if (fs.existsSync(fontPath)) {
        cachedCoverFonts[fontFamily] = fs.readFileSync(fontPath).toString('base64');
        console.log(`✅ Loaded cover font: ${fontFamily} from ${filename}`);
      } else {
        console.log(`❌ Cover font not found: ${fontPath}`);
      }
    }
  } catch (error) {
    console.error('Error loading cover fonts:', error);
    cachedCoverFonts = {};
  }
  return cachedCoverFonts;
}

function loadTemplatesOnce() {
  const shouldHotReload = process.env.NODE_ENV !== 'production' || process.env.PDF_TEMPLATES_HOT === 'true';
  if (!shouldHotReload && Object.keys(cachedTemplates).length) return cachedTemplates;
  try {
    const templatesDir = path.resolve(process.cwd(), 'pdf-templates');
    const pairs = [
      ['softcover', 'book-template-softcover.html'],
      // Prefer dedicated digital template; fallback to softcover if missing
      ['digital', 'book-template-digital.html'],
      ['hardcover', 'book-template-pages.html'],
      ['cover', 'cover-template.html'],
      ['cover-softcover', 'cover-template-softcover.html']
    ];
    const fresh = {};
    for (const [key, file] of pairs) {
      const p = path.join(templatesDir, file);
      if (fs.existsSync(p)) {
        fresh[key] = fs.readFileSync(p, 'utf8');
      } else if (key === 'digital') {
        // Fallback: use softcover as digital template if dedicated file is absent
        const soft = path.join(templatesDir, 'book-template-softcover.html');
        if (fs.existsSync(soft)) {
          console.warn('⚠️ Digital template not found, falling back to softcover template');
          fresh[key] = fs.readFileSync(soft, 'utf8');
        }
      }
    }
    cachedTemplates = fresh;
  } catch {}
  return cachedTemplates;
}

function buildHtml({ story, childName, childAge, selectedGender, options = {} }) {
  const templates = loadTemplatesOnce();
  const frankBase64 = loadCoverFontsOnce();
  const logoPath = path.resolve(process.cwd(), 'pdf-templates/logo.png');
  let siteLogoDataUrl = '';
  try {
    if (fs.existsSync(logoPath)) {
      const base64 = fs.readFileSync(logoPath).toString('base64');
      siteLogoDataUrl = `data:image/png;base64,${base64}`;
    }
  } catch {}
  let leafDataUrl = '';
  try {
    const leafPath = path.resolve(process.cwd(), 'pdf-templates/Leafe.svg');
    if (fs.existsSync(leafPath)) {
      const leafBase64 = fs.readFileSync(leafPath).toString('base64');
      leafDataUrl = `data:image/svg+xml;base64,${leafBase64}`;
    }
  } catch {}
  const genderKey = selectedGender === 'girl' ? 'female' : 'male';
  let sourcePages = [];
  if (Array.isArray(story.pages)) {
    sourcePages = story.pages;
  } else if (story.pages && story.pages[genderKey]) {
    sourcePages = story.pages[genderKey];
  } else if (story.pages) {
    sourcePages = story.pages;
  }
  const pages = (sourcePages || [])
    .map(p => (p.toObject ? p.toObject() : p));

  console.log('📝 [PDF Service] Digital PDF text debug:', {
    totalPages: pages.length,
    bookType: story?.bookType,
    sampleTexts: pages.slice(0, 3).map((pg, idx) => ({
      index: idx,
      preview: typeof pg?.text === 'string' ? pg.text.slice(0, 80) : null,
      hasText: !!pg?.text
    }))
  });

  const escapeHtml = (s = '') => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
  const hasRegular = !!(frankBase64?.SpacerRegular);
  const hasBold = !!(frankBase64?.FbSpacerBold);
  const hasBlack = !!(frankBase64?.FbSpacerBlack);
  if (!hasRegular || !hasBold || !hasBlack) {
    console.warn(`⚠️ [PDF Fonts] Missing fonts: Regular=${hasRegular}, Bold=${hasBold}, Black=${hasBlack}`);
  } else {
    console.log(`✅ [PDF Fonts] All fonts loaded: Regular=${frankBase64.SpacerRegular.length} chars, Bold=${frankBase64.FbSpacerBold.length} chars, Black=${frankBase64.FbSpacerBlack.length} chars`);
  }
  const fontCss = frankBase64 ? `
    @font-face{font-family:'FbSpacer';src:url('data:font/otf;base64,${frankBase64.SpacerRegular || ''}') format('opentype');font-weight:400;font-style:normal;font-display:swap;}
    @font-face{font-family:'FbSpacerBold';src:url('data:font/otf;base64,${frankBase64.FbSpacerBold || ''}') format('opentype');font-weight:700;font-style:normal;font-display:swap;}
    @font-face{font-family:'FbSpacerBlack';src:url('data:font/otf;base64,${frankBase64.FbSpacerBlack || ''}') format('opentype');font-weight:900;font-style:normal;font-display:swap;}
    html,body{font-family:'FbSpacer','FbSpacerBold','FbSpacerBlack',sans-serif;}
  ` : '';
  const optimizeForEmail = options?.optimizeForEmail === true;
  const emailOptimizeCss = optimizeForEmail ? `
    .sheet{ background: none !important; background-image: none !important; }
    .cover-image{ filter: none !important; }
  ` : '';
  const fixText = (t = '') => t
    .replace(/\[שם הילד\]/g, childName)
    .replace(/\[שם הילדה\]/g, childName)
    .replace(/\[שֵׁם הַיָּלֶד\]/g, childName)
    .replace(/\[שֵׁם הַיַּלְדָּה\]/g, childName)
    .replace(/\[גיל הילד\]/g, childAge || '')
    .replace(/\[גִּיל הַיָּלֶד\]/g, childAge || '');
  const isHardcover = story?.bookType === 'ספר כריכה קשה';
  const isSoftcover = story?.bookType === 'חוברת כריכה רכה';
  const isPhysical = isHardcover || isSoftcover;
  const pageBlock = ({ page: p, originalIndex, displayIndex }) => {
    const imageStateForPage = story?.imageState?.pages?.[originalIndex];
    const customSelectedImage = imageStateForPage?.images?.selectedImage;
    const customMainImage = imageStateForPage?.images?.mainImage;
    let imgSrc = customSelectedImage || customMainImage || p.imageUrl || '';
    if (optimizeForEmail) {
      imgSrc = optimizeImageUrl(imgSrc, { width: 600, quality: 40, fetchFormat: 'auto' });
    } else {
      imgSrc = optimizeImageUrl(imgSrc, { width: 2400, quality: 90, fetchFormat: 'auto' });
    }
    const textHtml = `<p class="story">${escapeHtml(fixText(p.text || ''))}</p>`;
    const imgHtml = imgSrc ? `<img class="img" src="${escapeHtml(imgSrc)}" />` : `<div class="img-fallback">תמונה חסרה</div>`;
    if (isHardcover || isSoftcover) {
      const cropMarks = `
        <div class="crop-mark top-left"></div>
        <div class="crop-mark top-right"></div>
        <div class="crop-mark bottom-left"></div>
        <div class="crop-mark bottom-right"></div>
      `;
      const bgStyle = imgSrc ? ` style="background-image:url('${escapeHtml(imgSrc)}')"` : '';
      const pageNum = displayIndex + 1;
      const headerHtml = leafDataUrl ? `
        <div style="position:absolute;left:0;right:0;top:12mm;display:flex;align-items:center;justify-content:center;gap:2mm;pointer-events:none;z-index:5;">
          <img src="${leafDataUrl}" alt="leaf-left" style="height:6mm;opacity:.65;transform:scaleX(-1);" />
          <span style="font-size:24pt;color:#5a6573;white-space:nowrap;">${escapeHtml(story.title || '')}</span>
          <img src="${leafDataUrl}" alt="leaf-right" style="height:6mm;opacity:.65;" />
        </div>` : '';
      const numberHtml = `
        <div style="position:absolute;left:0;right:0;bottom:12mm;display:flex;align-items:center;justify-content:center;pointer-events:none;color:#5a6573;font-size:24pt;z-index:5;">- ${pageNum} -</div>`;
      const imagePage = `<section class="page bg-image"${bgStyle}>${cropMarks}<div class="sheet"><div class="imgbox">${imgHtml}</div></div></section>`;
      const textPage = `<section class="page">${cropMarks}<div class="sheet">${headerHtml}<div class="textbox">${textHtml}</div>${numberHtml}</div></section>`;
      return imagePage + textPage;
    }
    const isRight = displayIndex % 2 === 0;
    const cropMarks = `
      <div class="crop-mark top-left"></div>
      <div class="crop-mark top-right"></div>
      <div class="crop-mark bottom-left"></div>
      <div class="crop-mark bottom-right"></div>
    `;
    const pageNum = displayIndex + 1;
    const headerHtml = leafDataUrl ? `
      <div style="position:absolute;left:0;right:0;top:6mm;display:flex;align-items:center;justify-content:center;gap:14mm;pointer-events:none;z-index:5;">
        <img src="${leafDataUrl}" alt="leaf-left" style="height:6mm;opacity:.65;transform:scaleX(-1);" />
        <span style="font-size:10pt;color:#5a6573;white-space:nowrap;">${escapeHtml(story.title || '')}</span>
        <img src="${leafDataUrl}" alt="leaf-right" style="height:6mm;opacity:.65;" />
      </div>` : '';
    const numberHtml = `
      <div style="position:absolute;left:0;right:0;bottom:6mm;display:flex;align-items:center;justify-content:center;pointer-events:none;color:#5a6573;font-size:10pt;z-index:5;">- ${pageNum} -</div>`;
    return `
      <section class="page ${isRight ? 'right' : 'left'}">
        ${cropMarks}
        <div class="sheet">
          ${headerHtml}
          ${isRight ? `<div class="imgbox">${imgHtml}</div><div class="textbox">${textHtml}</div>` : `<div class="textbox">${textHtml}</div><div class="imgbox">${imgHtml}</div>`}
          ${numberHtml}
        </div>
      </section>`;
  };
  const pageEntries = pages.map((page, originalIndex) => ({ page, originalIndex }));
  const filteredEntries = isPhysical ? pageEntries.filter(entry => entry.originalIndex !== 0) : pageEntries;
  const pagesHtml = filteredEntries.map((entry, displayIndex) => pageBlock({ ...entry, displayIndex })).join('');
  
  console.log('🧱 [PDF Service] Pages HTML debug:', {
    totalEntries: filteredEntries.length,
    htmlLength: pagesHtml.length,
    firstPageHtml: pagesHtml.slice(0, 300),
    containsStoryClass: pagesHtml.includes('class="story"'),
    textSample: pagesHtml.match(/<p class="story">([^<]{0,100})/)?.[1] || 'NOT FOUND'
  });
  
  let bookTypeKey = 'digital';
  if (story.bookType === 'ספר כריכה קשה') {
    bookTypeKey = 'hardcover';
  } else if (story.bookType === 'חוברת כריכה רכה') {
    bookTypeKey = 'softcover';
  } else {
    bookTypeKey = 'digital';
  }
  const template = templates[bookTypeKey] || templates['digital'];
  if (!template) {
    throw new Error(`Template not found for key: ${bookTypeKey}`);
  }
  const coverImageState = story?.imageState?.cover?.images;
  const customCoverSelected = coverImageState?.selectedImage;
  const customCoverMain = coverImageState?.mainImage;
  let coverImageSrc = '';
  if (customCoverSelected) {
    coverImageSrc = customCoverSelected;
  } else if (customCoverMain) {
    coverImageSrc = customCoverMain;
  } else if (story?.coverImage?.url) {
    coverImageSrc = story.coverImage.url;
  } else if (story?.coverImage?.base64) {
    const mimeType = story.coverImage?.mimeType || 'image/png';
    coverImageSrc = `data:${mimeType};base64,${story.coverImage.base64}`;
  }
  if (optimizeForEmail && coverImageSrc && !coverImageSrc.startsWith('data:')) {
    coverImageSrc = optimizeImageUrl(coverImageSrc, { width: 800, quality: 40, fetchFormat: 'auto' });
  } else if (coverImageSrc && !coverImageSrc.startsWith('data:')) {
    coverImageSrc = optimizeImageUrl(coverImageSrc, { width: 2400, quality: 90, fetchFormat: 'auto' });
  }
  const rawDedication = (story?.dedicationMessage || story?.backCoverText || '').trim();
  const fallbackChildName =
    childName ||
    story?.childName ||
    story?.bookData?.childName ||
    story?.bookContent?.childName ||
    '';
  const defaultDedication = fallbackChildName
    ? `ספר זה נוצר באהבה עבור ${fallbackChildName}`
    : 'ספר זה נוצר באהבה עבור ילד אהוב';
  const resolvedDedication = rawDedication || defaultDedication;
  const dedicationText = fixText(resolvedDedication).trim();
  const dedicationTitleText = (story?.title || story?.bookData?.title || 'מוקדש באהבה');
  const isPhysicalBook = bookTypeKey === 'hardcover' || bookTypeKey === 'softcover';
  // Build dedication title with leaf ornaments for physical books
  const dedicationTitle = isPhysicalBook && leafDataUrl
    ? `<div class="dedication-title-with-leaves"><img src="${leafDataUrl}" alt="leaf-left" class="dedication-leaf-left" /><span class="dedication-title-text">${escapeHtml(dedicationTitleText)}</span><img src="${leafDataUrl}" alt="leaf-right" class="dedication-leaf-right" /></div>`
    : escapeHtml(dedicationTitleText);
  const blankPages = '';
  return template
    .replace('/*__FONT_CSS__*/', fontCss + emailOptimizeCss)
    .replace(/{{BOOK_TITLE}}/g, escapeHtml(story?.title || ''))
    .replace(/{{BOOK_SUBTITLE}}/g, escapeHtml(story?.shortDescription || story?.backCoverText || ''))
    .replace(/{{BOOK_DESCRIPTION}}/g, escapeHtml(story?.backCoverText || story?.description || ''))
    .replace(/{{CHILD_NAME}}/g, escapeHtml(childName || ''))
    .replace(/{{COVER_IMAGE_URL}}/g, escapeHtml(coverImageSrc || ''))
    .replace(/{{SITE_LOGO_URL}}/g, siteLogoDataUrl || '')
    .replace(/{{BLANK_PAGES}}/g, blankPages)
    .replace(/{{DEDICATION_PAGE}}/g, `<section class="page dedication"><div class="dedication-sheet"><div class="dedication-card"><div class="dedication-title">${dedicationTitle}</div><div class="dedication-text">${escapeHtml(dedicationText)}</div><div class="dedication-accent">Magical-Book.com</div></div></div></section>`)
    .replace(/{{PAGES}}/g, pagesHtml);
}

export async function generatePdfBuffer({ story, childName, childAge, selectedGender, options = {} }) {
  const defaultOptions = {
    format: 'A4',
    orientation: 'portrait',
    margin: { top: '20mm', right: '20mm', bottom: '20mm', left: '20mm' },
    printBackground: true,
    preferCSSPageSize: true
  };
  const finalOptions = { ...defaultOptions, ...options };
  let browser;
  try {
    browser = await launchBrowserWithFallback([], 'generate-pdf');
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120000);
    const dsf = options?.optimizeForEmail ? 1.2 : 5;
    const vw = options?.optimizeForEmail ? 1000 : 1200;
    const vh = options?.optimizeForEmail ? 1400 : 1600;
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: dsf });
    const html = buildHtml({ story, childName, childAge, selectedGender, options: finalOptions });
    await logHtmlAssetWeights('digital-html', html);
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.emulateMediaType('print');
    await page.evaluateHandle('document.fonts.ready');
    await page.evaluate(() => {
      const wait = (img) => new Promise(res => {
        if (img.complete) return res();
        const t = setTimeout(res, 15000);
        img.onload = img.onerror = () => { clearTimeout(t); res(); };
      });
      return Promise.all([...document.images].map(wait));
    });
    const isHardcover = story?.bookType === 'ספר כריכה קשה';
    const isSoftcover = story?.bookType === 'חוברת כריכה רכה';
    const isPhysical = isHardcover || isSoftcover;
    let pageWidth = '225mm';
    let pageHeight = '225mm';
    if (isPhysical) {
      const spineWidth = isHardcover ? 8 : 5;
      const bleedSize = isHardcover ? 15 : 5;
      pageWidth = `${220 * 2 + spineWidth + bleedSize * 2}mm`;
      pageHeight = `${220 + bleedSize * 2}mm`;
    }
    const pdf = await page.pdf({
      ...(isPhysical ? { width: pageWidth, height: pageHeight } : { format: finalOptions.format, landscape: finalOptions.orientation === 'landscape' }),
      margin: isPhysical ? { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' } : finalOptions.margin,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="font-size:9pt;width:100%;text-align:center;color:#5a6573;font-family:PFTFrank;"><span class="pageNumber"></span></div>',
      scale: 1.0
    });
    return pdf;
  } finally {
    if (browser) await browser.close();
  }
}

export async function generateCoverPdfBuffer({ story, childName, childAge, options = {} }) {
  const defaultOptions = {
    format: 'A4',
    orientation: 'landscape',
    margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
    printBackground: true,
    preferCSSPageSize: true
  };
  const finalOptions = { ...defaultOptions, ...options };
  let browser;
  try {
    browser = await launchBrowserWithFallback([], 'generate-cover');
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 800, deviceScaleFactor: 5 });
    const templates = loadTemplatesOnce();
    const frankBase64 = loadFontOnce();
    const coverFonts = loadCoverFontsOnce();
    const isSoftcover = story?.bookType === 'חוברת כריכה רכה';
    const template = isSoftcover ? templates['cover-softcover'] : templates['cover'];
    const escapeHtml = (s = '') => s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
    const coverFontCss = Object.entries(coverFonts).map(([fontFamily, base64]) => 
      `@font-face{font-family:'${fontFamily}';src:url('data:font/otf;base64,${base64}') format('opentype');font-weight:normal;font-style:normal;}`
    ).join('\n');
    const fontCss = frankBase64 ? `
      @font-face{font-family:'PFTFrank';src:url('data:font/ttf;base64,${frankBase64}') format('truetype');font-weight:700;font-style:normal;font-display:swap;}
      html,body{font-family:'PFTFrank',sans-serif;}
    ` : '';
    const combinedFontCss = coverFontCss + '\n' + fontCss;
    let coverImageSrc = '';
    if (story?.coverImage?.base64) {
      const mimeType = story.coverImage?.mimeType || 'image/png';
      coverImageSrc = `data:${mimeType};base64,${story.coverImage.base64}`;
    } else if (story?.coverImage?.url) {
      coverImageSrc = story.coverImage.url;
      coverImageSrc = optimizeImageUrl(coverImageSrc, { width: 2400, quality: 90, fetchFormat: 'auto' });
    }
    let childPhotoSrc = '';
    if (story?.childPhoto?.base64) {
      const mimeType = story.childPhoto?.mimeType || 'image/png';
      childPhotoSrc = `data:${mimeType};base64,${story.childPhoto.base64}`;
    } else if (story?.childPhoto?.url) {
      childPhotoSrc = story.childPhoto.url;
      childPhotoSrc = optimizeImageUrl(childPhotoSrc, { width: 2400, quality: 90, fetchFormat: 'auto' });
    } else if (story?.uploadedImage) {
      childPhotoSrc = story.uploadedImage;
    } else if (story?.originalCharacterImage) {
      childPhotoSrc = story.originalCharacterImage;
    } else if (story?.characterImageBase64) {
      childPhotoSrc = story.characterImageBase64;
    } else if (story?.bookData?.characterImageBase64) {
      childPhotoSrc = story.bookData.characterImageBase64;
    } else if (story?.bookData?.uploadedImage) {
      childPhotoSrc = story.bookData.uploadedImage;
    }
    const imageForAi = story?.coverImage?.url || coverImageSrc;
    const [gradient1, gradient2] = await selectMonochromaticPalette({ imageUrl: imageForAi });
    const gradientCss = `.bg-tint{background:linear-gradient(90deg, ${gradient2}, ${gradient1}) !important;}`;
    const logoPath = path.resolve(process.cwd(), 'pdf-templates/logo.png');
    let siteLogoDataUrl = '';
    try {
      if (fs.existsSync(logoPath)) {
        const base64 = fs.readFileSync(logoPath).toString('base64');
        siteLogoDataUrl = `data:image/png;base64,${base64}`;
      }
    } catch {}
    const html = template
      .replace('/*__FONT_CSS__*/', combinedFontCss)
      .replace('/*__GRADIENT_CSS__*/', gradientCss)
      .replace(/{{BOOK_TITLE}}/g, escapeHtml(story?.title || ''))
      .replace(/{{BOOK_SUBTITLE}}/g, escapeHtml(story?.shortDescription || story?.backCoverText || ''))
      .replace(/{{BOOK_DESCRIPTION}}/g, escapeHtml(story?.backCoverText || story?.description || ''))
      .replace(/{{CHILD_NAME}}/g, escapeHtml(childName || ''))
      .replace(/{{COVER_IMAGE_URL}}/g, escapeHtml(coverImageSrc))
      .replace(/{{BACK_COVER_TEXT}}/g, escapeHtml(story?.backCoverText || ''))
      .replace(/{{CHILD_PHOTO_URL}}/g, escapeHtml(childPhotoSrc))
      .replace(/{{SITE_LOGO_URL}}/g, siteLogoDataUrl || '')
      .replace(/{{DEDICATION_MESSAGE}}/g, escapeHtml(story?.dedicationMessage || 'ספר מיוחד זה נוצר במיוחד עבורך, עם אהבה רבה'));
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.emulateMediaType('print');
    await page.evaluateHandle('document.fonts.ready');
    await page.evaluate(() => {
      const wait = (img) => new Promise(res => {
        if (img.complete) return res();
        const t = setTimeout(res, 15000);
        img.onload = img.onerror = () => { clearTimeout(t); res(); };
      });
      return Promise.all([...document.images].map(wait));
    });
    const isHardcover = story?.bookType === 'ספר כריכה קשה';
    const spineWidth = isHardcover ? 8 : 5;
    const bleedSize = isHardcover ? 15 : 5;
    const coverWidthMm = 220 * 2 + spineWidth + bleedSize * 2;
    const coverHeightMm = 220 + bleedSize * 2;
    const coverWidthInches = (coverWidthMm / 25.4).toFixed(4);
    const coverHeightInches = (coverHeightMm / 25.4).toFixed(4);
    const pdf = await page.pdf({
      width: `${coverWidthInches}in`,
      height: `${coverHeightInches}in`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      headerTemplate: '<div></div>',
      footerTemplate: '<div></div>',
      scale: 1.0
    });
    return pdf;
  } finally {
    if (browser) await browser.close();
  }
}

export async function generateTextOnlyPdfBuffer({ story, childName, childAge, selectedGender, options = {} }) {
  const defaultOptions = {
    format: 'A4',
    orientation: 'portrait',
    margin: { top: '5mm', right: '5mm', bottom: '5mm', left: '5mm' },
    printBackground: true,
    preferCSSPageSize: true
  };
  const finalOptions = { ...defaultOptions, ...options };
  let browser;
  try {
    const genderKey = selectedGender === 'girl' ? 'female' : 'male';
    const originalPages = story.pages?.[genderKey] || [];
    const textOnlyStory = {
      ...story,
      pages: story.pages ? { ...story.pages, [genderKey]: originalPages } : {},
      imageState: story.imageState
    };
    const html = buildHtml({ story: textOnlyStory, childName, childAge, selectedGender, options: finalOptions });
    browser = await launchBrowserWithFallback([], 'generate-text-only');
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 5 });
    await page.setContent(html, { waitUntil: ['networkidle0','domcontentloaded'] });
    await page.emulateMediaType('print');
    await page.evaluateHandle('document.fonts.ready');
    await page.evaluate(() => {
      const wait = (img) => new Promise(res => { if (img.complete) return res(); const t = setTimeout(res, 8000); img.onload = img.onerror = () => { clearTimeout(t); res(); }; });
      return Promise.all([...document.images].map(wait));
    });
    const pdf = await page.pdf({
      format: finalOptions.format,
      landscape: finalOptions.orientation === 'landscape',
      margin: finalOptions.margin,
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      headerTemplate: '<div></div>',
      footerTemplate: '<div style="font-size:9pt;width:100%;text-align:center;color:#5a6573;font-family:PFTFrank;"><span class="pageNumber"></span></div>',
      scale: 1.0,
      quality: 100
    });
    return pdf;
  } finally {
    if (browser) await browser.close();
  }
}

function escapeHtml(s = '') {
  return s.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] || ch));
}


