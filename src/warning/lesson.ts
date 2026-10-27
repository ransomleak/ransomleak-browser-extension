// The 60-second lesson, rendered inside the warning page (or standalone for consent / AI paste).
// All text goes in via textContent.
import { brandMark } from '../lib/brand.ts';
import { el } from '../lib/dom.ts';
import type { Strings } from '../lib/i18n.ts';
import { isHostname } from '../lib/domain.ts';
import { isStandaloneKind, type LessonKind, type StandaloneKind } from '../lesson/content.ts';
import { parse } from 'tldts';
import { fixedQuiz, lessonText, lookalikeQuiz, type QuizOption } from '../lesson/quiz.ts';

/** Brands whose name is not just the capitalised domain label. */
const BRAND_NAMES: Readonly<Record<string, string>> = { paypal: 'PayPal', linkedin: 'LinkedIn', github: 'GitHub', docusign: 'DocuSign', icloud: 'iCloud', whatsapp: 'WhatsApp', youtube: 'YouTube', wetransfer: 'WeTransfer', godaddy: 'GoDaddy', lastpass: 'LastPass', mcafee: 'McAfee', wellsfargo: 'Wells Fargo', bankofamerica: 'Bank of America', capitalone: 'Capital One', navyfederal: 'Navy Federal', usaa: 'USAA', hsbc: 'HSBC', bnpparibas: 'BNP Paribas', abnamro: 'ABN AMRO', commbank: 'CommBank', cash: 'Cash App', cashapp: 'Cash App', americanexpress: 'American Express', metamask: 'MetaMask', trustwallet: 'Trust Wallet', okx: 'OKX', dhl: 'DHL', fedex: 'FedEx', usps: 'USPS', royalmail: 'Royal Mail', laposte: 'La Poste', postnl: 'PostNL', novaposhta: 'Nova Poshta', privatbank: 'PrivatBank', epicgames: 'Epic Games', playstation: 'PlayStation', tiktok: 'TikTok', ebay: 'eBay', aliexpress: 'AliExpress', mercadolibre: 'Mercado Libre', openai: 'OpenAI', quickbooks: 'QuickBooks', jpmorgan: 'JPMorgan', jpmorganchase: 'JPMorgan Chase', 'deutsche-bank': 'Deutsche Bank', deutschebank: 'Deutsche Bank', 'credit-agricole': 'Crédit Agricole', societegenerale: 'Société Générale', steampowered: 'Steam', steamcommunity: 'Steam', aol: 'AOL', bybit: 'Bybit', kucoin: 'KuCoin', x: 'X' };

/** "microsoft.com" -> "Microsoft", "paypal.com" -> "PayPal": the quiz names the brand, never the answer itself. */
export function brandName(genuine: string): string {
  const label = parse(genuine).domainWithoutSuffix ?? genuine.split('.')[0] ?? genuine;
  return BRAND_NAMES[label] ?? label.charAt(0).toUpperCase() + label.slice(1);
}

export interface LessonCase {
  kind: LessonKind;
  domain: string | null;
  highlight?: [number, number];
  genuine: string | null;
  course: boolean;
  standalone: boolean;
  /** Brand-owned domains a generated fake must never equal. */
  deny?: string[];
}

const TOTAL = 4;

/** Domain text with an optional `<mark>` over [a, b). */
export function markedDomain(doc: Document, d: string, hl: [number, number] | undefined, cls = 'name'): HTMLParagraphElement {
  const name = el(doc, 'p', undefined, cls);
  const [a, b] = hl ?? [0, 0];
  const valid = Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b > a && b <= d.length;
  if (valid) name.append(doc.createTextNode(d.slice(0, a)), el(doc, 'mark', d.slice(a, b)), doc.createTextNode(d.slice(b)));
  else name.textContent = d;
  return name;
}

export function renderLesson(
  doc: Document,
  c: LessonCase,
  s: Strings,
  done: (a: 'back' | 'course') => void,
  record: () => void,
  backToWarning?: () => void,
): void {
  const t = lessonText(s);
  const lookalike = c.kind === 'lookalike' && !c.standalone;
  const generated = lookalike && c.genuine && c.domain ? lookalikeQuiz(c.genuine, c.domain, Math.random, c.deny ?? []) : null;
  const quiz: QuizOption[] = generated ?? fixedQuiz(s, c.kind);
  const question = generated ? t('lesson_genuine_q').replace('{brand}', brandName(c.genuine ?? '')) : t(`lesson_${c.kind}_q`);
  let recorded = false;

  const frame = (n: number): HTMLElement => {
    const main = el(doc, 'main', undefined, 'lesson');
    main.append(brandMark(doc));
    if (backToWarning && !c.standalone) {
      const back = el(doc, 'button', undefined, 'link back-warning');
      const arrow = el(doc, 'span', '←');
      arrow.setAttribute('aria-hidden', 'true');
      back.append(arrow, ` ${s.lesson_back_warning}`);
      back.type = 'button';
      back.addEventListener('click', backToWarning);
      main.append(back);
    }
    const dots = el(doc, 'div', undefined, 'dots');
    dots.setAttribute('role', 'img');
    dots.setAttribute('aria-label', s.lesson_step.replace('{n}', String(n)).replace('{total}', String(TOTAL)));
    for (let i = 1; i <= TOTAL; i++) dots.append(el(doc, 'i', undefined, i <= n ? 'on' : undefined));
    main.append(dots);
    return main;
  };
  const show = (main: HTMLElement): void => {
    doc.body.replaceChildren(main);
    const h = main.querySelector('h1');
    if (h) { h.tabIndex = -1; h.focus(); }
  };
  const actions = (main: HTMLElement, ...btns: HTMLButtonElement[]): void => {
    const row = el(doc, 'div', undefined, 'actions');
    row.append(...btns);
    main.append(row);
  };
  const btn = (text: string, cls: string, onClick: () => void): HTMLButtonElement => {
    const b = el(doc, 'button', text, cls);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  };

  const step1 = (): void => {
    const main = frame(1);
    main.append(el(doc, 'h1', t(`lesson_${c.kind}_title`)));
    if (lookalike && c.domain) {
      const box = el(doc, 'div', undefined, 'domain');
      box.append(el(doc, 'span', s.domain_label, 'label'), markedDomain(doc, c.domain, c.highlight, 'name case'));
      main.append(box);
      if (c.genuine) {
        const real = el(doc, 'div', undefined, 'domain genuine');
        real.append(el(doc, 'span', s.lesson_real_one, 'label'), el(doc, 'p', c.genuine, 'name real'));
        main.append(real);
      }
      main.append(el(doc, 'p', t('lesson_lookalike_what'), 'body'));
    } else {
      main.append(el(doc, 'p', t(`lesson_${c.kind}_what`), 'body'));
      if (!c.standalone && c.domain) {
        const box = el(doc, 'div', undefined, 'domain');
        box.append(el(doc, 'span', c.kind === 'download' ? s.dl_from_label : s.domain_label, 'label'), el(doc, 'p', c.domain, 'name case'));
        main.append(box);
      }
    }
    actions(main, btn(s.lesson_next, 'primary', step2));
    show(main);
  };

  const step2 = (): void => {
    const main = frame(2);
    main.append(el(doc, 'h1', t(`lesson_${c.kind}_title`)));
    const ul = el(doc, 'ul', undefined, 'habits');
    ul.append(el(doc, 'li', t(`lesson_${c.kind}_habit1`)), el(doc, 'li', t(`lesson_${c.kind}_habit2`)));
    main.append(ul);
    actions(main, btn(s.lesson_next, 'primary', step3));
    show(main);
  };

  const step3 = (): void => {
    const main = frame(3);
    main.append(el(doc, 'h1', question));
    const opts = el(doc, 'div', undefined, 'options');
    const why = el(doc, 'p', undefined, 'status why');
    why.setAttribute('role', 'status');
    for (const o of quiz) {
      const b = btn(o.text, 'option', () => {
        if (o.correct) { step4(); return; }
        for (const x of opts.querySelectorAll('button')) x.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        b.classList.add('wrong');
        why.textContent = generated
          ? t('lesson_genuine_why').replace('{domain}', c.genuine ?? '').replace('{brand}', brandName(c.genuine ?? ''))
          : t(`lesson_${c.kind}_why`);
      });
      b.setAttribute('aria-pressed', 'false');
      opts.append(b);
    }
    main.append(opts, why);
    show(main);
  };

  const step4 = (): void => {
    if (!recorded) { recorded = true; record(); }
    const main = frame(4);
    main.append(el(doc, 'h1', s.lesson_done_title), el(doc, 'p', s.lesson_done_body, 'body'));
    const back = btn(s.lesson_back_safety, 'primary', () => done('back'));
    if (c.course) actions(main, back, btn(s.lesson_open_course, 'secondary', () => done('course')));
    else actions(main, back);
    show(main);
  };

  step1();
}

/** Parses `?lesson=<kind>&d=<host>` for the standalone page. Kind must be consent|aipaste; `d` null when invalid. */
export function standaloneFromUrl(search: string): { kind: StandaloneKind; domain: string | null } | null {
  const q = new URLSearchParams(search);
  const kind = q.get('lesson');
  if (!isStandaloneKind(kind)) return null;
  const d = q.get('d');
  return { kind, domain: isHostname(d) ? d : null };
}
