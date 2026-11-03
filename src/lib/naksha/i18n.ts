/**
 * Naksha — i18n-lite (Phase 8)
 *
 * Persian UI labels for the MAIN CHROME (status bar, vault panel, perf
 * panel) behind the `settings lang fa|en` choice. Deliberately small:
 *
 *  - English stays the default and the fallback (a missing key renders
 *    its English text — never an empty string, never a key name).
 *  - This does NOT touch terminal command syntax, receipts, or command
 *    names (those stay English/LTR — Phase 8 keeps the terminal's input
 *    row LTR on purpose); only chrome LABELS flip.
 *  - `uiLang` and `direction` are separate settings on purpose: a user
 *    may want Persian labels with LTR chrome or vice versa. `lang fa`
 *    prints a hint about `settings direction rtl` instead of silently
 *    coupling them.
 */

import { useNaksha } from './store';

export type UiLang = 'en' | 'fa';

type Dict = Record<string, string>;

const FA: Dict = {
  /* status bar */
  'sb.map': 'نقشه',
  'sb.fs': 'فایل‌ها',
  'sb.ctx': 'زمینه',
  'sb.node': 'گره',
  'sb.net': 'شبکه',
  'sb.cmd': 'فرمان',
  'sb.perf': 'کارایی',
  'sb.internal': 'داخلی',
  'sb.connected': 'متصل',
  'sb.dir': 'جهت',

  /* vault panel */
  'vault.title': 'گنجینه',
  'vault.notConnected': 'متصل نیست',
  'vault.unavailable': 'در دسترس نیست',
  'vault.refresh': 'نوسازی',
  'vault.disconnect': 'قطع اتصال',
  'vault.readonly': 'فقط‌خواندنی',
  'vault.careWritable': 'قابل‌نوشتن ♦',
  'vault.connect': 'اتصال',

  /* perf panel */
  'perf.title': 'کارایی',
  'perf.low.name': 'کم‌مصرف',
  'perf.low.desc': 'بدون انیمیشن و محو‌شدگی — برای پردازنده‌های ضعیف',
  'perf.stable60.name': 'پایدار ۶۰',
  'perf.stable60.desc': '۶۰ فریم قفل‌شده — تعامل کامل، شیشه‌ی مات',
  'perf.high.name': 'کامل',
  'perf.high.desc': 'همه‌ی جلوه‌ها فعال — شیشه‌ی شفاف و ذرات',
};

const EN: Dict = {};

/**
 * Translate a chrome label. English text is passed INLINE by the caller
 * (`t('sb.map', 'MAP')`) so the English default needs no dictionary and
 * a missing Persian key degrades to the exact string that rendered
 * before Phase 8 — a label can never regress to empty.
 */
export function t(key: string, english: string): string {
  const lang = useNaksha.getState().settings.uiLang ?? 'en';
  if (lang === 'fa') return FA[key] ?? english;
  return english;
}

/** True when the chrome should render Persian labels. */
export function isFa(): boolean {
  return (useNaksha.getState().settings.uiLang ?? 'en') === 'fa';
}
