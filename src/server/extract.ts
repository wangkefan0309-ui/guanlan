import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { materialSchema, webUrl } from '../core/model';
import type { Material, Topic } from '../core/model';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export interface ExtractOptions { url?: string; title?: string; source?: string; sourceId?: string; categoryId?: string; categoryName?: string; identity?: string; topic?: Topic; capturedAt?: string }
function meta(document: Document, key: string): string { return document.querySelector(`meta[property="${key}"]`)?.getAttribute('content')?.trim() ?? ''; }
function scriptString(html: string, key: string): string {
  const match = [...html.matchAll(new RegExp(`\\b${key}\\s*[:=]\\s*("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*')`, 'g'))].find(match => match[1]!.length > 2);
  return (match?.[1]?.slice(1, -1) ?? '').replace(/\\(?:x([0-9a-f]{2})|u([0-9a-f]{4})|([\\'"nrtbf])|\r?\n)/gi, (_match, hex: string, unicode: string, escape: string) => {
    if (hex || unicode) return String.fromCharCode(parseInt(hex || unicode, 16));
    return ({ n:'\n', r:'\r', t:'\t', b:'\b', f:'\f' } as Record<string,string>)[escape] ?? escape ?? '';
  });
}
export function identifyWechat(html: string): { name: string; biz: string; wechatId: string } {
  const { document } = parseHTML(html);
  return {
    name: document.querySelector('#js_name')?.textContent?.trim() || scriptString(html, 'nick_name') || scriptString(html, 'nickname') || '',
    biz: scriptString(html, 'biz') || html.match(/biz\s*=\s*''\s*\|\|\s*'([^']+)'/)?.[1] || '',
    wechatId: scriptString(html, 'user_name'),
  };
}
/** WeChat's displayed create_time is Beijing local time, never the fetch time. */
export function wechatPublishedAt(html: string): string | undefined {
  const value = scriptString(html, 'create_time');
  const formatted = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  if (formatted) {
    const date = new Date(`${formatted[1]}T${formatted[2]}:${formatted[3] ?? '00'}+08:00`);
    if (Number.isFinite(date.getTime()) && new Date(date.getTime() + 8 * 3600_000).toISOString().slice(0, 16) === `${formatted[1]}T${formatted[2]}`) return date.toISOString();
    return undefined;
  }
  const timestamp = html.match(/\b(?:ct|create_time)\s*[:=]\s*["']?(\d{10})(?!\d)["']?(?=\s*[,;\n}])/ )?.[1];
  return timestamp ? new Date(Number(timestamp) * 1000).toISOString() : undefined;
}
export function extractHtml(html: string, options: ExtractOptions = {}): Material {
  const url = options.url ? webUrl.parse(options.url) : undefined;
  const { document } = parseHTML(html);
  const shortText = scriptString(html, 'content_noencode');
  const isWechat = url ? new URL(url).hostname === 'mp.weixin.qq.com' : !!document.querySelector('#js_content') || !!shortText;
  const fieldDocument = parseHTML(`<html><body>${shortText}</body></html>`).document;
  const fieldIsHtml = /^\s*<(?:p|section|div|span|a|strong|em|br|hr|img|h[1-6]|mp-[\w-]+)\b/i.test(shortText)
    && /(?:<\/[\w-]+>|<(?:br|hr|img|mp-[\w-]+)\b[^>]*\/?>)\s*$/i.test(shortText)
    && [...fieldDocument.body.childNodes].every(node => node.nodeType === 1 || !node.textContent?.trim());
  const fieldTitle = (fieldIsHtml ? fieldDocument.body.textContent : shortText)?.trim().split('\n')[0];
  const title = (document.querySelector('#activity-name')?.textContent?.trim() || meta(document, 'og:title') || options.title || fieldTitle || document.title || '未命名网页').slice(0, 240);
  const source = identifyWechat(html).name || options.source || meta(document, 'og:site_name') || (url ? new URL(url).hostname : '手动网页');
  let article = document.querySelector('#js_content');
  const originalPayPreview = !!article?.querySelector('mp-pay-preview-filter,.js_pay_preview_filter');
  let scope = '微信公众号正文';
  const contentProbe = article?.cloneNode(true) as Element | undefined;
  for (const node of contentProbe?.querySelectorAll('script,style,iframe,video,audio,object,embed,input,button,svg') ?? []) node.remove();
  if (!contentProbe?.textContent?.replace(/[\s\p{Cf}]/gu, '') && shortText && isWechat) {
    const shortDoc = parseHTML('<html><body><article></article></body></html>').document;
    article = shortDoc.querySelector('article');
    // WeChat uses this field for both plain short posts and HTML hydrated into an empty container.
    if (fieldIsHtml) article!.innerHTML = shortText;
    else article!.textContent = shortText;
    scope = '微信公众号页面内容字段提取';
  }
  if (!article && !isWechat) {
    const readable = new Readability(document.cloneNode(true) as unknown as Document).parse();
    if (readable?.content) article = parseHTML(`<html><body><article>${readable.content}</article></body></html>`).document.querySelector('article');
    scope = '网页主内容提取';
  }
  const gaps: string[] = [];
  if (originalPayPreview || article?.querySelector('mp-pay-preview-filter,.js_pay_preview_filter')) gaps.push('仅取得付费预览的公开部分，未取得付费完整正文。');
  if (article) {
    for (const node of article.querySelectorAll('script,style,iframe,video,audio,object,embed,input,button,svg')) { node.remove(); }
    for (const image of article.querySelectorAll('img')) {
      const address = image.getAttribute('data-src') || image.getAttribute('src') || '';
      if (/^https?:\/\//i.test(address)) { image.setAttribute('src', address); image.setAttribute('alt', image.getAttribute('alt') || '原文图片'); }
      else image.remove();
    }
    for (const link of article.querySelectorAll('a')) {
      const href = link.getAttribute('href');
      try { if (!href) throw new Error(); const resolved = new URL(href, url); if (!['https:', 'http:'].includes(resolved.protocol)) throw new Error(); link.setAttribute('href', resolved.toString()); }
      catch { link.removeAttribute('href'); }
    }
  }
  const converter = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced' });
  const body = article ? converter.turndown(article.innerHTML).trim() : '';
  const hasBody = body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[\s\p{Cf}]/gu, '').length > 0;
  if (article?.querySelector('img')) gaps.push('图片保留远程链接，尚未下载或进行图像理解；离线阅读图片可能不可用。');
  gaps.push(`${scope}；HTML 原件已保留，提取文本不包含原页面的交互与完整版式。`);
  if (!hasBody) gaps.push('未找到可用正文，可能为验证页、短内容结构或动态页面；请打开原文核对。');
  return materialSchema.parse({
    title, source, sourceId: options.sourceId, categoryId: options.categoryId, categoryName: options.categoryName, url, identity: options.identity || url || `local:html:${options.title || title}`, topic: options.topic ?? 'ai-learning', kind: 'article',
    publishedAt: wechatPublishedAt(html),
    capturedAt: options.capturedAt ?? new Date().toISOString(), body: hasBody ? body : '', coverage: hasBody ? 'partial' : 'metadata', gaps,
    guide: hasBody ? body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\s+/g, ' ').slice(0, 180) : '',
    guideKind: hasBody ? 'excerpt' : 'none', original: { extension: 'html', base64: Buffer.from(html).toString('base64') },
  });
}
export async function extractPdf(bytes: Uint8Array, options: ExtractOptions = {}): Promise<Material> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = join(dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')), 'standard_fonts').replace(/\\/g, '/') + '/';
  const task = getDocument({ data: Uint8Array.from(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl });
  let body = ''; const missing: number[] = []; const gaps: string[] = ['仅提取 PDF 文本层，图表、扫描图片和复杂版式尚未进行 OCR 或视觉解释。'];
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 300) throw new Error('PDF 超过 300 页，请按章节拆分后导入');
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo); const content = await page.getTextContent();
      const text = content.items.map(item => 'str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : '').join('').trim();
      body += `## 第 ${pageNo} 页\n\n${text || '本页没有可提取的文本层。'}\n\n`;
      if (!text) missing.push(pageNo);
      if (body.length > 1_500_000) throw new Error('提取文本过长，请按章节导入');
    }
    const hasText = body.replace(/## 第 \d+ 页|本页没有可提取的文本层。|\s/g, '').length > 0;
    // Chunk page numbers so even 300 alternating scan pages fit within the schema limits.
    for (let offset = 0; offset < missing.length; offset += 50) gaps.push(`第 ${missing.slice(offset, offset + 50).join('、')} 页没有文本层，需要 OCR 或原件阅读。`);
    return materialSchema.parse({
      title: options.title || '手动 PDF', source: options.source || '手动导入', url: options.url, identity: options.identity || options.url || `local:pdf:${options.title || '手动 PDF'}`,
      topic: options.topic ?? 'finance', kind: 'pdf', capturedAt: options.capturedAt ?? new Date().toISOString(), body: hasText ? body.trim() : '', coverage: hasText ? 'partial' : 'metadata', gaps,
      guide: hasText ? '已按原文件页码提取文本，请结合 PDF 原件核对图表与版式。' : '', guideKind: hasText ? 'excerpt' : 'none', original: { extension: 'pdf', base64: Buffer.from(bytes).toString('base64') },
    });
  } finally { await task.destroy(); }
}
