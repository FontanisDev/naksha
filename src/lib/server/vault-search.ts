/* ── Trilium-style search dialect for the file vault (v138 T7 round 5) ──
 *
 * Ported from TriliumNext/Notes (develop branch) — the battle-tested
 * search pipeline in apps/server/src/services/search/:
 *   services/lex.ts · services/handle_parens.ts · services/parse.ts ·
 *   services/build_comparator.ts · services/types.ts ·
 *   expressions/{and,or,not,true,property_comparison,attribute_exists,
 *   label_comparison,note_content_fulltext,order_by_and_limit}.ts ·
 *   value_extractor.ts
 * studied via https://deepwiki.com/TriliumNext/Notes (the golden
 * reference). The port keeps upstream's grammar, operator set, error
 * wording and evaluation order; the ADAPTATION is the note model:
 *
 *   Trilium note  →  file in the connected directory (.md, dotfiles stay
 *   out of the reader, 800-file walk cap shared with the other surfaces)
 *     note.title        → basename without .md
 *     note.content      → file body (rawcontent = same bytes — a file IS
 *                         its raw blob; alias kept so the grammar holds)
 *     note.text         → upstream's virtual field (title *=* v OR content
 *                         *=* v) — only the *=* operator, as upstream
 *     note.dateCreated  → file birthtime  "YYYY-MM-DD HH:mm:ss"
 *     note.dateModified → file mtime      "YYYY-MM-DD HH:mm:ss"
 *     note.contentSize  → byte size (numeric comparators)
 *     note.type / mime  → honest constants ('text' / 'text/markdown')
 *     note.isArchived   → 'false' (flat dir: nothing is archived)
 *     #label            → YAML frontmatter pair `name: value` (name +
 *                         value lowercased, like every upstream compare)
 *     ~relation, note.parents/children/ancestors/relations
 *                       → refuse at parse time with an honest message:
 *                         a flat file vault has no note graph.
 *
 * Laziness (the file-backed budget): AndExp evaluates sub-expressions in
 * order, so parse() puts the STRUCTURED expression BEFORE the fulltext
 * one — property/label filters shrink the candidate set before any file
 * body is read. Content and frontmatter are read through readFile once
 * per file and cached (readFile already refuses binary + >2MB).
 *
 * Everything is READ-ONLY by construction: it walks with the reader's
 * machinery and writes nothing. */

import {
  listDir,
  readFile,
  classifyVaultHead,
  VaultPathError,
  type VaultEntry,
} from './vault';

/* Upstream walks with NAKSHA_SCAN_CAP=800 — the same budget every vault
 * surface here shares (recent, findNakshaFiles). Kept in step BY HAND:
 * vault.ts owns the canonical constant (not exported — one more export
 * on a hot module vs a stale-copy risk; review round will dedup). */
const NAKSHA_SCAN_CAP = 800;

/* ── types.ts (ported) ──────────────────────────────────────────────── */

export interface TokenData {
  token: string;
  inQuotes?: boolean;
  startIndex?: number;
  endIndex?: number;
}

export type TokenStructure = (TokenData | TokenStructure)[];

/* Diacritic folding without the normalize-strings dependency: NFD split
 * + combining-mark strip covers the Latin range upstream normalizes. */
function removeDiacritic(str: string): string {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/* ── lex.ts (ported; upstream lowercases the whole string so every
 * comparison downstream is case-insensitive by construction) ─────────── */

function lex(input: string) {
  const str = input.toLowerCase();

  let fulltextQuery = '';
  const fulltextTokens: TokenData[] = [];
  const expressionTokens: TokenStructure = [];

  let quotes: boolean | string = false; // otherwise contains used quote - ', " or `
  let fulltextEnded = false;
  let currentWord = '';

  function isSymbolAnOperator(chr: string) {
    return ['=', '*', '>', '<', '!', '-', '+', '%', ','].includes(chr);
  }

  function isPreviousSymbolAnOperator() {
    if (currentWord.length === 0) {
      return false;
    }
    return isSymbolAnOperator(currentWord[currentWord.length - 1]);
  }

  function finishWord(endIndex: number, createAlsoForEmptyWords = false) {
    if (currentWord === '' && !createAlsoForEmptyWords) {
      return;
    }

    const rec: TokenData = {
      token: currentWord,
      inQuotes: !!quotes,
      startIndex: endIndex - currentWord.length + 1,
      endIndex,
    };

    if (fulltextEnded) {
      expressionTokens.push(rec);
    } else {
      fulltextTokens.push(rec);
      fulltextQuery = str.slice(0, endIndex + 1);
    }

    currentWord = '';
  }

  for (let i = 0; i < str.length; i++) {
    const chr = str[i];

    if (chr === '\\') {
      if (i + 1 < str.length) {
        i++;
        currentWord += str[i];
      } else {
        currentWord += chr;
      }
      continue;
    } else if (['"', "'", '`'].includes(chr)) {
      if (!quotes) {
        if (currentWord.length === 0 || isPreviousSymbolAnOperator()) {
          finishWord(i - 1);
          quotes = chr;
        } else {
          // quote inside a word does not have special meaning and does not break word
          // e.g. d'Artagnan is kept as a single token
          currentWord += chr;
        }
      } else if (quotes === chr) {
        finishWord(i - 1, true);
        quotes = false;
      } else {
        // it's a quote, but within other kind of quotes, so it's valid as a literal character
        currentWord += chr;
      }
      continue;
    } else if (!quotes) {
      if (!fulltextEnded && currentWord === 'note' && chr === '.' && i + 1 < str.length) {
        fulltextEnded = true;
      }

      /* FILE-VAULT ADAPTATION (documented deviation): upstream reaches a
       * leading `orderby note.title …` through its SEPARATE orderBy
       * query param (the search box splits the grammar for it); this
       * vault exposes only the string grammar, so a STANDALONE
       * orderby/limit keyword (followed by a space) switches to
       * expression mode here — `vault find orderby note.title asc
       * limit 10` parses as the sort sheet it reads as. To search the
       * literal word, quote it. */
      if (
        !fulltextEnded && (currentWord === 'orderby' || currentWord === 'limit') &&
        chr === ' ' && i + 1 < str.length
      ) {
        fulltextEnded = true;
      }

      if (chr === '#' || chr === '~') {
        if (!fulltextEnded) {
          fulltextEnded = true;
        } else {
          finishWord(i - 1);
        }
        currentWord = chr;
        continue;
      } else if (['#', '~'].includes(currentWord) && chr === '!') {
        currentWord += chr;
        continue;
      } else if (chr === ' ') {
        finishWord(i - 1);
        continue;
      } else if (fulltextEnded && ['(', ')', '.'].includes(chr)) {
        finishWord(i - 1);
        currentWord += chr;
        finishWord(i);
        continue;
      } else if (fulltextEnded && !['#!', '~!'].includes(currentWord) && isPreviousSymbolAnOperator() !== isSymbolAnOperator(chr)) {
        finishWord(i - 1);
        currentWord += chr;
        continue;
      }
    }

    if (chr === ',') {
      continue;
    }

    currentWord += chr;
  }

  finishWord(str.length - 1);
  fulltextQuery = fulltextQuery.trim();

  return { fulltextQuery, fulltextTokens, expressionTokens };
}

/* ── handle_parens.ts (ported verbatim) ─────────────────────────────── */

function handleParens(tokens: TokenStructure): TokenStructure {
  if (tokens.length === 0) {
    return [];
  }

  while (true) {
    const leftIdx = tokens.findIndex((token) => !Array.isArray(token) && token.token === '(');
    if (leftIdx === -1) {
      return tokens;
    }

    let rightIdx: number;
    let parensLevel = 0;

    for (rightIdx = leftIdx; rightIdx < tokens.length; rightIdx++) {
      const token = tokens[rightIdx];
      if (Array.isArray(token)) continue;
      if (token.token === ')') {
        parensLevel--;
        if (parensLevel === 0) break;
      } else if (token.token === '(') {
        parensLevel++;
      }
    }

    if (rightIdx >= tokens.length) {
      throw new Error('Did not find matching right parenthesis.');
    }

    tokens = [
      ...tokens.slice(0, leftIdx),
      handleParens(tokens.slice(leftIdx + 1, rightIdx)),
      ...tokens.slice(rightIdx + 1),
    ] as TokenStructure;
  }
}

/* ── build_comparator.ts (ported verbatim) ──────────────────────────── */

const cachedRegexes: Record<string, RegExp> = {};
/* upstream's NoteContentFulltext caches its regexes with 'ms' flags — a
 * SEPARATE cache from build_comparator's flagless one (same key must
 * never resolve to different flag sets) */
const cachedMsRegexes: Record<string, RegExp> = {};

function getRegex(str: string) {
  if (!(str in cachedRegexes)) {
    cachedRegexes[str] = new RegExp(str);
  }
  return cachedRegexes[str];
}

type Comparator<T> = (comparedValue: T) => (val: string) => boolean;

const stringComparators: Record<string, Comparator<string>> = {
  '=': (comparedValue) => (val) => val === comparedValue,
  '!=': (comparedValue) => (val) => val !== comparedValue,
  '>': (comparedValue) => (val) => val > comparedValue,
  '>=': (comparedValue) => (val) => val >= comparedValue,
  '<': (comparedValue) => (val) => val < comparedValue,
  '<=': (comparedValue) => (val) => val <= comparedValue,
  '*=': (comparedValue) => (val) => !!val && val.endsWith(comparedValue),
  '=*': (comparedValue) => (val) => !!val && val.startsWith(comparedValue),
  '*=*': (comparedValue) => (val) => !!val && val.includes(comparedValue),
  '%=': (comparedValue) => (val) => !!val && !!getRegex(comparedValue).test(val),
};

const numericComparators: Record<string, Comparator<number>> = {
  '>': (comparedValue) => (val) => parseFloat(val) > comparedValue,
  '>=': (comparedValue) => (val) => parseFloat(val) >= comparedValue,
  '<': (comparedValue) => (val) => parseFloat(val) < comparedValue,
  '<=': (comparedValue) => (val) => parseFloat(val) <= comparedValue,
};

function buildComparator(operator: string, comparedValue: string) {
  comparedValue = comparedValue.toLowerCase();

  if (operator in numericComparators && !isNaN(+comparedValue)) {
    return numericComparators[operator](parseFloat(comparedValue));
  }

  if (operator in stringComparators) {
    return stringComparators[operator](comparedValue);
  }
  return undefined;
}

/* ── the file-backed note model ─────────────────────────────────────── */

export interface VaultSearchNote {
  rel: string;
  /** basename without the .md extension — note.title */
  title: string;
  size: number;
  mtimeMs: number;
  birthtimeMs: number;
  /* lazily loaded (one readFile per note, cached): */
  _raw?: string | null; // original case, snippet-faithful
  _flat?: string | null; // diacritic-folded + lowercased — the compare form
  _contentTried?: boolean;
  _labels?: Record<string, string> | null;
  _labelsTried?: boolean;
}

function fmtStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDay(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* Frontmatter pairs = the file analog of labels. Parsed from the first
 * `--- … ---` block of the cached content; `key: value` lines only —
 * no YAML nesting/lists (an honest boundary, stated in the usage
 * receipt: nested structures are not labels). Name + value are
 * lowercased at parse time, matching upstream's compare form. */
function parseFrontmatterLabels(raw: string): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!raw.startsWith('---')) return labels;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return labels;
  const block = raw.slice(3, end);
  for (const line of block.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):[ \t]*(.*)$/);
    if (!m) continue;
    const name = m[1].trim().toLowerCase();
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (name) labels[name] = value.toLowerCase();
  }
  return labels;
}

interface EvalContext {
  root: string;
  notes: Map<string, VaultSearchNote>;
  contentReads: number;
  addError(msg: string): void;
  loadContent(note: VaultSearchNote): Promise<{ raw: string; flat: string } | null>;
  loadLabels(note: VaultSearchNote): Promise<Record<string, string>>;
}

/* ── expressions (upstream classes, ported onto rel-id sets) ────────── */

abstract class Expression {
  abstract execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>>;
  abstract describe(): string;
}

class TrueExp extends Expression {
  async execute(input: Set<string>): Promise<Set<string>> {
    return input;
  }
  describe(): string {
    return 'true';
  }
}

class AndExp extends Expression {
  subExpressions: Expression[];

  static of(_subExpressions: (Expression | null | undefined)[]): Expression {
    const subExpressions = _subExpressions.filter((exp) => !!exp) as Expression[];
    if (subExpressions.length === 1) return subExpressions[0];
    if (subExpressions.length > 0) return new AndExp(subExpressions);
    return new TrueExp();
  }

  constructor(subExpressions: Expression[]) {
    super();
    this.subExpressions = subExpressions;
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    for (const subExpression of this.subExpressions) {
      input = await subExpression.execute(input, ctx);
    }
    return input;
  }

  describe(): string {
    return this.subExpressions.map((e) => e.describe()).join(' AND ');
  }
}

class OrExp extends Expression {
  subExpressions: Expression[];

  static of(subExpressions: Expression[]): Expression {
    subExpressions = subExpressions.filter((exp) => !!exp);
    if (subExpressions.length === 1) return subExpressions[0];
    if (subExpressions.length > 0) return new OrExp(subExpressions);
    return new TrueExp();
  }

  constructor(subExpressions: Expression[]) {
    super();
    this.subExpressions = subExpressions;
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    const resultNoteSet: Set<string> = new Set();
    for (const subExpression of this.subExpressions) {
      for (const id of await subExpression.execute(input, ctx)) {
        resultNoteSet.add(id);
      }
    }
    return resultNoteSet;
  }

  describe(): string {
    return `(${this.subExpressions.map((e) => e.describe()).join(' OR ')})`;
  }
}

class NotExp extends Expression {
  subExpression: Expression;

  constructor(subExpression: Expression) {
    super();
    this.subExpression = subExpression;
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    const subNoteSet = await this.subExpression.execute(input, ctx);
    const out = new Set<string>();
    for (const id of input) if (!subNoteSet.has(id)) out.add(id);
    return out;
  }

  describe(): string {
    return `NOT (${this.subExpression.describe()})`;
  }
}

/* property_comparison.ts — PROP_MAPPING trimmed to the properties a flat
 * file vault honestly has (see the header table). isProperty() keeps the
 * upstream name. */
const PROP_MAPPING: Record<string, string> = {
  title: 'title',
  content: 'content',
  rawcontent: 'rawcontent',
  text: 'text',
  datecreated: 'dateCreated',
  created: 'dateCreated',
  datemodified: 'dateModified',
  modified: 'dateModified',
  contentsize: 'contentSize',
  type: 'type',
  mime: 'mime',
  isarchived: 'isArchived',
};

class PropertyComparisonExp extends Expression {
  propertyName: string;
  operator: string;
  comparedValue: string;
  private comparator: ((val: string) => boolean) | undefined;

  static isProperty(name: string) {
    return name in PROP_MAPPING;
  }

  constructor(propertyName: string, operator: string, comparedValue: string) {
    super();
    this.propertyName = PROP_MAPPING[propertyName];
    this.operator = operator;
    this.comparedValue = comparedValue;
    this.comparator = buildComparator(operator, comparedValue);
  }

  private async valueOf(note: VaultSearchNote, ctx: EvalContext): Promise<string | undefined> {
    switch (this.propertyName) {
      case 'title':
        return note.title.toLowerCase();
      case 'content':
      case 'rawcontent': {
        const c = await ctx.loadContent(note);
        return c ? c.flat : undefined;
      }
      case 'text': {
        // upstream: virtual field — only *=* reaches it through parse()
        const c = await ctx.loadContent(note);
        const title = note.title.toLowerCase();
        return c ? `${title} ${c.flat}` : title;
      }
      case 'dateCreated':
        return fmtStamp(note.birthtimeMs).toLowerCase();
      case 'dateModified':
        return fmtStamp(note.mtimeMs).toLowerCase();
      case 'contentSize':
        return String(note.size);
      case 'type':
        return 'text'; // every md note — honest constant
      case 'mime':
        return 'text/markdown';
      case 'isArchived':
        return 'false'; // flat dir — nothing archived
      default:
        return undefined;
    }
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    const resNoteSet = new Set<string>();
    for (const id of input) {
      const note = ctx.notes.get(id);
      if (!note) continue;
      let value = await this.valueOf(note, ctx);
      /* upstream stringifies non-strings then lowercases; valueOf here
       * already returns string | undefined — the ?? '' keeps the
       * comparator contract (undefined behaves exactly like the empty
       * string for every upstream comparator: guarded or unequal) */
      if (value) value = value.toLowerCase();
      if (this.comparator && this.comparator(value ?? '')) {
        resNoteSet.add(id);
      }
    }
    return resNoteSet;
  }

  describe(): string {
    return `note.${this.propertyName.toLowerCase()} ${this.operator} "${this.comparedValue}"`;
  }
}

/* attribute_exists.ts — labels live in frontmatter; inheritance/relation
 * machinery upstream does not exist here, so execute is a direct probe. */
class AttributeExistsExp extends Expression {
  attributeName: string;
  private prefixMatch: boolean;

  constructor(attributeName: string, prefixMatch: boolean) {
    super();
    this.attributeName = attributeName.toLowerCase();
    this.prefixMatch = prefixMatch;
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    const resultNoteSet = new Set<string>();
    for (const id of input) {
      const note = ctx.notes.get(id);
      if (!note) continue;
      const labels = await ctx.loadLabels(note);
      const hit = this.prefixMatch
        ? Object.keys(labels).some((k) => k.startsWith(this.attributeName))
        : this.attributeName in labels;
      if (hit) resultNoteSet.add(id);
    }
    return resultNoteSet;
  }

  describe(): string {
    return `#${this.attributeName}${this.prefixMatch ? '*' : ''} exists`;
  }
}

/* label_comparison.ts */
class LabelComparisonExp extends Expression {
  attributeName: string;
  comparator: ((value: string) => boolean) | undefined;
  operator: string;
  comparedValue: string;

  constructor(attributeName: string, comparator: ((value: string) => boolean) | undefined, operator: string, comparedValue: string) {
    super();
    this.attributeName = attributeName.toLowerCase();
    this.comparator = comparator;
    this.operator = operator;
    this.comparedValue = comparedValue;
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    const resultNoteSet = new Set<string>();
    for (const id of input) {
      const note = ctx.notes.get(id);
      if (!note) continue;
      const labels = await ctx.loadLabels(note);
      const value = labels[this.attributeName];
      if (this.comparator && this.comparator(value ?? '')) {
        resultNoteSet.add(id);
      }
    }
    return resultNoteSet;
  }

  describe(): string {
    return `#${this.attributeName} ${this.operator} "${this.comparedValue}"`;
  }
}

/* note_content_fulltext.rs → ts — content fulltext over the cached
 * bodies. ALLOWED_OPERATORS + the 'ms' regex behavior are upstream. */
const CONTENT_OPERATORS = new Set(['=', '!=', '*=*', '*=', '=*', '%=']);

class NoteContentFulltextExp extends Expression {
  private operator: string;
  tokens: string[];

  constructor(operator: string, tokens: string[]) {
    super();
    this.operator = operator;
    this.tokens = tokens;
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    if (!CONTENT_OPERATORS.has(this.operator)) {
      ctx.addError(`Note content can be searched only with operators: ${Array.from(CONTENT_OPERATORS).join(', ')}, operator ${this.operator} given.`);
      return input;
    }
    const resultNoteSet = new Set<string>();
    for (const id of input) {
      const note = ctx.notes.get(id);
      if (!note) continue;
      const c = await ctx.loadContent(note);
      if (!c) continue;
      let matched = true;
      if (this.operator === '%=') {
        // upstream: the token is a regex over the content ('ms' flags)
        matched = this.tokens.every((t) => {
          const re = cachedMsRegexes[t] ?? (cachedMsRegexes[t] = new RegExp(t, 'ms'));
          return re.test(c.flat);
        });
      } else {
        const comparator = buildComparator(this.operator, this.tokens.join(' '));
        matched = !!comparator && !!comparator(c.flat);
      }
      if (matched) resultNoteSet.add(id);
    }
    return resultNoteSet;
  }

  describe(): string {
    return `content ${this.operator} "${this.tokens.join(' ')}"`;
  }
}

/* note_flat_text.ts — every token must appear somewhere in the note's
 * flat surface (title, rel path, labels). Upstream additionally walks
 * ancestors' titles: our honest analog is the rel path itself. */
class NoteFlatTextExp extends Expression {
  tokens: string[];

  constructor(tokens: string[]) {
    super();
    this.tokens = tokens;
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    const resultNoteSet = new Set<string>();
    for (const id of input) {
      const note = ctx.notes.get(id);
      if (!note) continue;
      const labels = await ctx.loadLabels(note);
      const flatText = removeDiacritic(
        [note.title, note.rel, ...Object.keys(labels), ...Object.values(labels)].join(' '),
      ).toLowerCase();
      if (this.tokens.every((t) => flatText.includes(t))) {
        resultNoteSet.add(id);
      }
    }
    return resultNoteSet;
  }

  describe(): string {
    return `flat text *=* "${this.tokens.join(' ')}"`;
  }
}

/* value_extractor.ts — propertyPath must start with 'note'; terminal
 * properties from PROP_MAPPING; labels.<name> terminal; graph steps
 * (parents/children/relations) refuse — no note graph in a file vault. */
class ValueExtractor {
  private propertyPath: string[];

  constructor(propertyPath: string[]) {
    this.propertyPath = propertyPath;
  }

  /** 'note.title' · 'note.labels.status' — for receipts/describe */
  pathString(): string {
    return this.propertyPath.join('.');
  }

  validate(): string | undefined {
    if (this.propertyPath[0] !== 'note') {
      return `property specifier must start with 'note', but starts with '${this.propertyPath[0]}'`;
    }
    for (let i = 1; i < this.propertyPath.length; i++) {
      const pathEl = this.propertyPath[i];
      if (pathEl === 'labels') {
        if (i !== this.propertyPath.length - 2) {
          return 'label is a terminal property specifier and must be at the end';
        }
        i++;
      } else if (pathEl in PROP_MAPPING || pathEl === 'random') {
        if (i !== this.propertyPath.length - 1) {
          return `${pathEl} is a terminal property specifier and must be at the end`;
        }
      } else if (pathEl === 'parents' || pathEl === 'children' || pathEl === 'relations') {
        return `'${pathEl}' does not exist in a flat file vault (no note graph)`;
      } else {
        return `Unrecognized property specifier ${pathEl}`;
      }
    }
    return undefined;
  }

  async extract(note: VaultSearchNote, ctx: EvalContext): Promise<string | number | null> {
    let i = 0;
    const cur = () => this.propertyPath[i];
    for (i = 1; i < this.propertyPath.length; i++) {
      if (cur() === 'labels') {
        i++;
        const labels = await ctx.loadLabels(note);
        return labels[this.propertyPath[i]] ?? null;
      }
      if (cur() === 'random') {
        return Math.random().toString(); // string is expected for comparison
      }
      if (cur() in PROP_MAPPING) {
        const prop = PROP_MAPPING[cur()];
        switch (prop) {
          case 'title': return note.title.toLowerCase();
          case 'content':
          case 'rawcontent': {
            const c = await ctx.loadContent(note);
            return c ? c.flat : null;
          }
          case 'dateCreated': return fmtStamp(note.birthtimeMs);
          case 'dateModified': return fmtStamp(note.mtimeMs);
          case 'contentSize': return note.size;
          default: return prop; // type/mime/isArchived constants
        }
      }
    }
    return null;
  }
}

/* order_by_and_limit.ts — upstream's null-last sort + date/number
 * coercion, ported onto the async extractor. */
interface OrderDefinition {
  direction?: string;
  smaller: number;
  larger: number;
  valueExtractor: ValueExtractor;
}

class OrderByAndLimitExp extends Expression {
  private orderDefinitions: OrderDefinition[];
  limit: number;
  subExpression: Expression | null;

  constructor(orderDefinitions: Pick<OrderDefinition, 'direction' | 'valueExtractor'>[], limit?: number) {
    super();
    this.orderDefinitions = orderDefinitions as OrderDefinition[];
    for (const od of this.orderDefinitions) {
      od.smaller = od.direction === 'asc' ? -1 : 1;
      od.larger = od.direction === 'asc' ? 1 : -1;
    }
    this.limit = limit || 0;
    this.subExpression = null; // it's expected to be set after construction
  }

  async execute(input: Set<string>, ctx: EvalContext): Promise<Set<string>> {
    if (!this.subExpression) {
      throw new Error('Missing subexpression');
    }

    let notes = Array.from(await this.subExpression.execute(input, ctx));

    const extracted = new Map<string, (string | number | null)[]>();
    for (const id of notes) {
      const note = ctx.notes.get(id);
      if (!note) continue;
      const vals: (string | number | null)[] = [];
      for (const od of this.orderDefinitions) {
        vals.push(await od.valueExtractor.extract(note, ctx));
      }
      extracted.set(id, vals);
    }
    notes = notes.filter((id) => extracted.has(id));

    notes.sort((a, b) => {
      const valsA = extracted.get(a)!;
      const valsB = extracted.get(b)!;
      for (let k = 0; k < this.orderDefinitions.length; k++) {
        const { smaller, larger } = this.orderDefinitions[k];
        let valA: string | number | null = valsA[k];
        let valB: string | number | null = valsB[k];

        if (valA === undefined) valA = null;
        if (valB === undefined) valB = null;

        if (valA === null && valB === null) continue;
        else if (valB === null) return smaller;
        else if (valA === null) return larger;

        // if both are dates, then parse them for dates comparison
        if (typeof valA === 'string' && this.isDate(valA) && typeof valB === 'string' && this.isDate(valB)) {
          valA = new Date(valA).getTime();
          valB = new Date(valB).getTime();
        }
        // if both are numbers, then parse them for numerical comparison
        else if (typeof valA === 'string' && this.isNumber(valA) && typeof valB === 'string' && this.isNumber(valB)) {
          valA = parseFloat(valA);
          valB = parseFloat(valB);
        }

        if (!valA && !valB) continue;
        else if ((valA as number) < (valB as number)) return smaller;
        else if ((valA as number) > (valB as number)) return larger;
      }
      return 0;
    });

    if (this.limit > 0) {
      notes = notes.slice(0, this.limit);
    }

    return new Set(notes);
  }

  isDate(date: number | string) {
    return !isNaN(new Date(date).getTime());
  }

  isNumber(x: number | string) {
    if (typeof x === 'number') return true;
    if (typeof x === 'string') {
      return x.trim() !== '' && !isNaN(parseInt(x, 10));
    }
    return false;
  }

  describe(): string {
    const orders = this.orderDefinitions.map((od) => `${od.valueExtractor.pathString()} ${od.direction ?? 'asc'}`).join(', ');
    const sub = this.subExpression ? this.subExpression.describe() : '';
    return `${sub}${orders ? ` ORDER BY ${orders}` : ''}${this.limit ? ` LIMIT ${this.limit}` : ''}`;
  }
}

/* ── parse.ts (ported; graph-only branches replaced by honest refusals,
 * ancestor/archived pre-filters dropped — the reader already hides
 * dotfiles and a flat dir has no archive) ───────────────────────────── */

const OPERATORS = new Set(['=', '!=', '*=*', '*=', '=*', '>', '>=', '<', '<=', '%=']);

function isOperator(token: TokenData | TokenStructure): boolean {
  if (Array.isArray(token)) return false;
  return OPERATORS.has(token.token);
}

interface SearchContext {
  errors: string[];
  highlighted: string[];
  originalQuery: string;
  fastSearch?: boolean;
  fuzzyAttributeSearch: boolean;
  addError(msg: string): void;
}

function getFulltext(_tokens: TokenData[], searchContext: SearchContext): Expression | null {
  const tokens: string[] = _tokens.map((t) => removeDiacritic(t.token));
  searchContext.highlighted.push(...tokens);
  if (tokens.length === 0) return null;
  if (!searchContext.fastSearch) {
    return new OrExp([new NoteFlatTextExp(tokens), new NoteContentFulltextExp('*=*', tokens)]);
  }
  return new NoteFlatTextExp(tokens);
}

function getExpression(tokens: TokenData[], searchContext: SearchContext, level = 0): Expression | null {
  if (tokens.length === 0) {
    return null;
  }

  const expressions: Expression[] = [];
  let op: string | null = null;
  let i = 0;

  function context(idx: number) {
    let { startIndex, endIndex } = tokens[idx];
    startIndex = Math.max(0, (startIndex || 0) - 20);
    endIndex = Math.min(searchContext.originalQuery.length, (endIndex ?? Number.MAX_SAFE_INTEGER) + 20);
    return `"${startIndex !== 0 ? '...' : ''}${searchContext.originalQuery.slice(startIndex, endIndex)}${endIndex !== searchContext.originalQuery.length ? '...' : ''}"`;
  }

  const resolveConstantOperand = (): string | null => {
    const operand = tokens[i];

    if (!operand.inQuotes && (operand.token.startsWith('#') || operand.token.startsWith('~') || operand.token === 'note')) {
      searchContext.addError(`Error near token "${operand.token}" in ${context(i)}, it's possible to compare with constant only.`);
      return null;
    }

    if (operand.inQuotes || !['now', 'today', 'month', 'year'].includes(operand.token)) {
      return operand.token;
    }

    let delta = 0;

    if (i + 2 < tokens.length) {
      if (tokens[i + 1].token === '+') {
        i += 2;
        delta += parseInt(tokens[i].token);
      } else if (tokens[i + 1].token === '-') {
        i += 2;
        delta -= parseInt(tokens[i].token);
      }
    }

    // upstream uses dayjs; plain Date arithmetic covers the four units
    let date: Date;
    let format: 'datetime' | 'day' | 'month' | 'year';

    if (operand.token === 'now') {
      date = new Date(Date.now() + delta * 1000);
      format = 'datetime';
    } else if (operand.token === 'today') {
      date = new Date(); date.setDate(date.getDate() + delta);
      format = 'day';
    } else if (operand.token === 'month') {
      date = new Date(); date.setMonth(date.getMonth() + delta);
      format = 'month';
    } else if (operand.token === 'year') {
      date = new Date(); date.setFullYear(date.getFullYear() + delta);
      format = 'year';
    } else {
      throw new Error(`Unrecognized keyword: ${operand.token}`);
    }

    const p = (n: number) => String(n).padStart(2, '0');
    if (format === 'datetime') {
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
    } else if (format === 'day') {
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
    } else if (format === 'month') {
      return `${date.getFullYear()}-${p(date.getMonth() + 1)}`;
    }
    return String(date.getFullYear());
  };

  const parseNoteProperty = (): Expression | undefined | null => {
    if (tokens[i].token !== '.') {
      searchContext.addError('Expected "." to separate field path');
      return undefined;
    }

    i++;

    if (['content', 'rawcontent'].includes(tokens[i].token)) {
      i += 1;
      const operator = tokens[i];
      if (!operator || !isOperator(operator)) {
        searchContext.addError(`After content expected operator, but got "${operator ? operator.token : 'END'}" in ${context(i)}`);
        return undefined;
      }
      i += 1;
      if (!tokens[i]) {
        searchContext.addError(`Missing compared value after operator in ${context(Math.min(i, tokens.length - 1))}`);
        return undefined;
      }
      return new NoteContentFulltextExp(operator.token, [tokens[i].token]);
    }

    if (tokens[i].token === 'parents' || tokens[i].token === 'children' || tokens[i].token === 'ancestors') {
      searchContext.addError(`note.${tokens[i].token} does not exist in a flat file vault (no note graph) — search by title/content/labels instead`);
      return undefined;
    }

    if (tokens[i].token === 'relations') {
      searchContext.addError('relations do not exist in a flat file vault (no note graph)');
      return undefined;
    }

    if (tokens[i].token === 'labels') {
      if (!tokens[i + 1] || tokens[i + 1].token !== '.') {
        searchContext.addError(`Expected "." to separate field path, got "${tokens[i + 1] ? tokens[i + 1].token : 'END'}" in ${context(i)}`);
        return undefined;
      }
      i += 2;
      return parseLabel(tokens[i].token);
    }

    if (tokens[i].token === 'text') {
      if (!tokens[i + 1] || tokens[i + 1].token !== '*=*') {
        searchContext.addError(`Virtual attribute "note.text" supports only *=* operator, instead given "${tokens[i + 1] ? tokens[i + 1].token : 'END'}" in ${context(i)}`);
        return undefined;
      }
      i += 2;
      return new OrExp([
        new PropertyComparisonExp('title', '*=*', tokens[i].token),
        new NoteContentFulltextExp('*=*', [tokens[i].token]),
      ]);
    }

    if (PropertyComparisonExp.isProperty(tokens[i].token)) {
      const propertyName = tokens[i].token;
      const operator = tokens[i + 1];
      if (!operator || !isOperator(operator)) {
        searchContext.addError(`After note.${propertyName} expected operator, but got "${operator ? operator.token : 'END'}" in ${context(i)}`);
        return undefined;
      }
      i += 2;
      const comparedValue = resolveConstantOperand();
      if (!comparedValue) {
        searchContext.addError('Unresolved constant operand.');
        return undefined;
      }
      return new PropertyComparisonExp(propertyName, operator.token, comparedValue);
    }

    searchContext.addError(`Unrecognized note property "${tokens[i].token}" in ${context(i)}`);
    return undefined;
  };

  function parseAttribute(name: string): Expression | null | undefined {
    const isLabel = name.startsWith('#');
    name = name.slice(1);
    const isNegated = name.startsWith('!');
    if (isNegated) {
      name = name.slice(1);
    }
    /* relations are refused honestly instead of parsed */
    if (!isLabel) {
      searchContext.addError('relations (~) do not exist in a flat file vault (no note graph)');
      return undefined;
    }
    const subExp = parseLabel(name);
    return subExp && isNegated ? new NotExp(subExp) : subExp;
  }

  function parseLabel(labelName: string): Expression | null | undefined {
    searchContext.highlighted.push(labelName);

    if (i < tokens.length - 2 && isOperator(tokens[i + 1])) {
      let operator = tokens[i + 1].token;
      i += 2;
      const comparedValue = resolveConstantOperand();
      if (comparedValue === null) {
        return undefined;
      }
      searchContext.highlighted.push(comparedValue);
      if (searchContext.fuzzyAttributeSearch && operator === '=') {
        operator = '*=*';
      }
      const comparator = buildComparator(operator, comparedValue);
      if (!comparator) {
        searchContext.addError(`Can't find operator '${operator}' in ${context(i - 1)}`);
        return undefined;
      }
      return new LabelComparisonExp(labelName, comparator, operator, comparedValue);
    }
    return new AttributeExistsExp(labelName, searchContext.fuzzyAttributeSearch);
  }

  function parseOrderByAndLimit(): OrderByAndLimitExp | undefined {
    const orderDefinitions: { valueExtractor: ValueExtractor; direction: string }[] = [];
    let limit: number | undefined = undefined;

    if (tokens[i].token === 'orderby') {
      do {
        const propertyPath: string[] = [];
        let direction = 'asc';

        do {
          i++;
          propertyPath.push(tokens[i].token);
          i++;
        } while (i < tokens.length && tokens[i].token === '.');

        if (i < tokens.length && ['asc', 'desc'].includes(tokens[i].token)) {
          direction = tokens[i].token;
          i++;
        }

        const valueExtractor = new ValueExtractor(propertyPath);
        const validationError = valueExtractor.validate();
        if (validationError) {
          searchContext.addError(validationError);
        }
        orderDefinitions.push({ valueExtractor, direction });
      } while (i < tokens.length && tokens[i].token === ',');
    }

    if (i < tokens.length && tokens[i].token === 'limit') {
      limit = parseInt(tokens[i + 1].token);
      i += 1;
    }

    return new OrderByAndLimitExp(orderDefinitions, limit);
  }

  function getAggregateExpression(): Expression {
    if (op === null || op === 'and') {
      return AndExp.of(expressions);
    } else if (op === 'or') {
      return OrExp.of(expressions);
    }
    throw new Error(`Unrecognized op=${op}`);
  }

  for (i = 0; i < tokens.length; i++) {
    if (Array.isArray(tokens[i])) {
      const expression = getExpression(tokens[i] as unknown as TokenData[], searchContext, level + 1);
      if (expression) {
        expressions.push(expression);
      }
      continue;
    }

    const token = tokens[i].token;

    if (token === '#' || token === '~') {
      continue;
    }

    if (token.startsWith('#') || token.startsWith('~')) {
      const attribute = parseAttribute(token);
      if (attribute) {
        expressions.push(attribute);
      }
    } else if (['orderby', 'limit'].includes(token)) {
      if (level !== 0) {
        searchContext.addError('orderBy can appear only on the top expression level');
        continue;
      }
      const exp = parseOrderByAndLimit();
      if (!exp) {
        continue;
      }
      exp.subExpression = getAggregateExpression();
      return exp;
    } else if (token === 'not') {
      i += 1;
      if (!Array.isArray(tokens[i])) {
        searchContext.addError(`not keyword should be followed by sub-expression in parenthesis, got ${tokens[i] && !Array.isArray(tokens[i]) ? tokens[i].token : 'END'} instead`);
        continue;
      }
      const tokenArray = tokens[i] as unknown as TokenData[];
      const expression = getExpression(tokenArray, searchContext, level + 1);
      if (!expression) {
        return null;
      }
      expressions.push(new NotExp(expression));
    } else if (token === 'note') {
      i += 1;
      if (!tokens[i]) {
        searchContext.addError('Expected "." after "note" (e.g. note.title *=* x) — a bare word is searched as fulltext');
        return null;
      }
      const expression = parseNoteProperty();
      if (!expression) {
        return null;
      }
      expressions.push(expression);
      continue;
    } else if (['and', 'or'].includes(token)) {
      if (!op) {
        op = token;
      } else if (op !== token) {
        searchContext.addError('Mixed usage of AND/OR - always use parenthesis to group AND/OR expressions.');
      }
    } else if (isOperator({ token })) {
      searchContext.addError(`Misplaced or incomplete expression "${token}"`);
    } else {
      searchContext.addError(`Unrecognized expression "${token}"`);
    }

    if (!op && expressions.length > 1) {
      op = 'and';
    }
  }

  return getAggregateExpression();
}

/* ── the executor: walk + evaluate ──────────────────────────────────── */

export interface VaultSearchOpts {
  query: string;
  dir?: string;
  /** window cap AFTER evaluation (the expression's own `limit` applies
   * inside the tree like upstream). Default 100, hard 200. */
  limit?: number;
  fuzzyAttributeSearch?: boolean;
  fastSearch?: boolean;
}

export interface VaultSearchMatch {
  rel: string;
  title: string;
  size: number;
  mtimeMs: number;
  kind: 'node' | 'shape' | 'none';
  tombstone: boolean;
  name?: string;
  /** first line containing a highlighted token (window only; from the
   * raw body so the case the author wrote is what shows) */
  snippet?: string;
}

export interface VaultSearchResult {
  parsed: string;
  errors: string[];
  highlighted: string[];
  matches: VaultSearchMatch[];
  total: number;
  scanned: number;
  truncated: boolean;
  contentReads: number;
}

export async function searchVault(root: string, opts: VaultSearchOpts): Promise<VaultSearchResult> {
  const windowCap = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 100)));
  const query = opts.query;

  /* Lexer → parens → parse — upstream's pipeline order. */
  const { fulltextTokens, expressionTokens } = lex(query);

  const errors: string[] = [];
  const highlighted: string[] = [];
  const searchContext: SearchContext = {
    errors,
    highlighted,
    originalQuery: query.toLowerCase(),
    fastSearch: opts.fastSearch,
    fuzzyAttributeSearch: opts.fuzzyAttributeSearch ?? false,
    addError(msg: string) {
      if (!this.errors.includes(msg)) this.errors.push(msg);
    },
  };

  let expressionTokensStructured: TokenStructure = expressionTokens;
  try {
    expressionTokensStructured = handleParens(expressionTokens);
  } catch (err) {
    searchContext.addError((err as Error).message);
  }

  /* Walk the candidate set FIRST (the walk validates the requested dir
   * loudly — listDir refuses hidden segments and safeResolve jails every
   * step, so a hostile dir fails BEFORE any evaluation, never as a
   * silent empty answer). Dotfiles never enter the reader. */
  const notes = new Map<string, VaultSearchNote>();
  let scanned = 0;
  let truncated = false;

  const walk = async (dirRel: string): Promise<void> => {
    if (scanned >= NAKSHA_SCAN_CAP) {
      truncated = true;
      return;
    }
    let entries: VaultEntry[];
    try {
      entries = await listDir(root, dirRel);
    } catch (err) {
      // the START dir already proved listable; per-directory errors stay
      // forgiving exactly like listRecentChanges' walk
      if (dirRel === (opts.dir ?? '')) throw err;
      return;
    }
    for (const e of entries) {
      if (scanned >= NAKSHA_SCAN_CAP) {
        truncated = true;
        return;
      }
      if (e.type === 'dir') {
        await walk(e.rel);
        continue;
      }
      if (!/\.(md|markdown)$/i.test(e.name)) continue;
      scanned++;
      notes.set(e.rel, {
        rel: e.rel,
        title: e.name.replace(/\.(md|markdown)$/i, ''),
        size: e.size,
        mtimeMs: e.mtimeMs,
        birthtimeMs: e.birthtimeMs,
      });
    }
  };

  await walk(opts.dir ?? '');

  const ctx: EvalContext = {
    root,
    notes,
    contentReads: 0,
    addError(msg: string) {
      if (!errors.includes(msg)) errors.push(msg);
    },
    async loadContent(note) {
      if (note._contentTried) {
        return note._raw ? { raw: note._raw, flat: note._flat ?? '' } : null;
      }
      note._contentTried = true;
      try {
        const r = await readFile(root, note.rel);
        ctx.contentReads++;
        note._raw = r.content;
        note._flat = removeDiacritic(r.content).toLowerCase();
        return { raw: note._raw, flat: note._flat };
      } catch {
        // binary / over-cap / unreadable — skipped honestly, never faked
        note._raw = null;
        note._flat = null;
        return null;
      }
    },
    async loadLabels(note) {
      if (note._labelsTried) return note._labels ?? {};
      note._labelsTried = true;
      const c = await ctx.loadContent(note);
      note._labels = c ? parseFrontmatterLabels(c.raw) : {};
      return note._labels;
    },
  };

  /* Parse. Upstream wraps the whole getExpression in try/catch and falls
   * back to TrueExp — a hostile query still answers with the fulltext
   * half plus its errors, never a thrown 500. */
  let parsedExpression: Expression | undefined | null;
  try {
    parsedExpression = getExpression(expressionTokensStructured as unknown as TokenData[], searchContext);
  } catch (e) {
    searchContext.addError((e as Error).message);
    parsedExpression = new TrueExp();
  }

  const fulltextExp = getFulltext(fulltextTokens, searchContext);

  /* AndExp order: STRUCTURED expression first, fulltext second — the
   * file-backed laziness win (AndExp is commutative in effect; property
   * filters shrink the set before content reads happen). Upstream's
   * fixed order exists because their fulltext pre-filters in SQL. */
  const tree = AndExp.of([parsedExpression ?? null, fulltextExp]);

  let resultIds: Set<string>;
  try {
    resultIds = await tree.execute(new Set(notes.keys()), ctx);
  } catch (e) {
    searchContext.addError((e as Error).message);
    resultIds = new Set();
  }

  /* Window: classification + snippet are deferred to the visible cap —
   * the same budget discipline listRecentChanges uses (heads and snippet
   * reads only for what will actually be shown). */
  const allIds = Array.from(resultIds);
  const windowIds = allIds.slice(0, Math.min(windowCap, allIds.length));
  const matches: VaultSearchMatch[] = [];
  for (const id of windowIds) {
    const note = notes.get(id);
    if (!note) continue;
    const cls = await classifyVaultHead(root, note.rel, note.size);
    const match: VaultSearchMatch = {
      rel: note.rel,
      title: note.title,
      size: note.size,
      mtimeMs: note.mtimeMs,
      kind: cls.kind,
      tombstone: cls.tombstone,
      ...(cls.name ? { name: cls.name } : {}),
    };
    // snippet: only when the body was actually loaded during evaluation
    if (note._raw) {
      const lower = note._raw.toLowerCase();
      let idx = -1;
      for (const tok of highlighted) {
        if (!tok) continue;
        idx = lower.indexOf(tok);
        if (idx !== -1) break;
      }
      if (idx !== -1) {
        const lineStart = note._raw.lastIndexOf('\n', idx) + 1;
        const lineEnd = note._raw.indexOf('\n', idx);
        match.snippet = note._raw.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 200);
      }
    }
    matches.push(match);
  }

  return {
    parsed: tree.describe(),
    errors,
    highlighted,
    matches,
    total: allIds.length,
    scanned,
    truncated: truncated || allIds.length > windowCap,
    contentReads: ctx.contentReads,
  };
}

export function assertSearchQuery(query: unknown): asserts query is string {
  if (typeof query !== 'string' || !query.trim()) {
    throw new VaultPathError('query required (e.g. note.title *=* plan AND #status = done orderby note.dateModified desc limit 10)');
  }
}
