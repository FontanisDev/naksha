/**
 * Naksha — Theme System
 *
 * Multiple hand-crafted themes, each a complete color palette.
 * Themes switch by setting `data-theme="<id>"` on <html>, which
 * re-defines the `--naksha-*` CSS variables.
 *
 * Each theme is designed with good taste — calm, eye-friendly,
 * with a clear accent color that carries positive energy.
 */

import type { MapLayerKey } from './types';

export interface NakshaTheme {
  id: string;
  name: string;
  description: string;
  /** Preview swatch colors (for the theme picker UI) */
  swatch: string[];
  /** The CSS variable overrides applied when this theme is active. */
  vars: Record<string, string>;
  /** Basemap that fits this theme's chroma (Task 33): light paper themes
   *  read wrong over ESRI dark-gray tiles, dark themes read wrong over
   *  OSM standard. The theme-switch migration only CHANGES the map when
   *  the user never diverged from the previous theme's default. */
  mapLayer: MapLayerKey;
}

export const THEMES: NakshaTheme[] = [
  {
    id: 'amber-night',
    name: 'Amber Night',
    description: 'Metallic gunmetal night under shining gold — the mountaintop city, reforged',
    swatch: ['#0e1013', '#ffd700', '#eef1f7', '#9a8ce1'],
    mapLayer: 'dark',
    /* v138 T3 — the metallic re-tone. The old paper was warm BROWN dark
     * (#1a1611 family) with an ochre yellow (#d4a017); the brief asked for
     * a metallic shiny dark + a shiny gold, with the remaining colors
     * re-matched to that pairing by color theory:
     *   · base  → GUNMETAL (polished steel/titanium): cool graphite ramp
     *     #0e1013 → #15181c → #1c2026, hue ≈215° at very low chroma — the
     *     same "dark metal" family watchmakers plate dials on.
     *   · accent → 24k GOLD #ffd700 (hue ≈51°, full sat) with a sheen
     *     highlight #ffe55c and a quiet #8f7514 — gold/gold-light/gold-dim
     *     keep the established three-voice accent contract.
     *   · text → PLATINUM/SILVER neutrals (cool, no brown cast): the
     *     precious-metal pairing (gold accent on platinum type).
     *   · semantics → jewel tones on gunmetal (emerald/ruby/sapphire),
     *     which harmonize with gold the way gemstones harmonize with a
     *     gold setting; warning stays = gold.
     *   · purple keeps the Task-91 heritage marker hue #9a8ce1 (it reads
     *     luminous on gunmetal and the marker parity contract holds);
     *     net-1/2/3 keep their orchid/rose/aqua identities.
     *   · the T1 star field re-tones with the theme: stars go metallic
     *     slate #4e5a68 and the pointer bloom goes from the retired
     *     sky-blue #63b3ed to the theme's own gold — the last sky-blue
     *     accent leaves amber-night. */
    vars: {
      '--naksha-bg': '#0e1013',
      '--naksha-bg-2': '#15181c',
      '--naksha-bg-3': '#1c2026',
      '--naksha-glass': 'rgba(28, 32, 38, 0.72)',
      '--naksha-glass-2': 'rgba(36, 41, 48, 0.6)',
      '--naksha-glass-strong': 'rgba(14, 16, 19, 0.92)',
      /* Task 113 — wash/scrim ride the theme's own ink family (wash = the
       * glass family, scrim = the glass-strong family), so inner cards and
       * modal scrims stay tint-coherent instead of wearing the amber-night
       * baseline on every paper. amber-night's values ARE the :root
       * defaults — pixel parity here. */
      '--naksha-wash': 'rgb(28, 32, 38)',
      '--naksha-scrim': 'rgb(14, 16, 19)',
      '--naksha-border': 'rgba(255, 215, 0, 0.14)',
      '--naksha-border-2': 'rgba(255, 215, 0, 0.28)',
      '--naksha-border-3': 'rgba(255, 215, 0, 0.5)',
      '--naksha-text': '#e7eaf0',
      '--naksha-text-2': '#9aa3b2',
      '--naksha-text-3': '#5d6673',
      '--naksha-text-4': '#3e4650',
      '--naksha-gold': '#ffd700',
      '--naksha-gold-light': '#ffe55c',
      '--naksha-gold-dim': '#8f7514',
      '--naksha-cream': '#eef1f7',
      '--naksha-warm': '#d2bc82',
      '--naksha-success': '#3ecf8e',
      '--naksha-error': '#e5484d',
      '--naksha-info': '#6fa8dc',
      '--naksha-warning': '#ffd700',
      /* Task 91 — purple now has READERS (the violet accent family:
         markers, halos, loc/perf chips — it was zero-reader decor
         before). The value is #9a8ce1, the exact hue the map markers
         have always rendered — the default theme keeps pixel parity —
         and stays distinct from TAG_COLORS.purple (#9b7ec8), which
         shares the map surface via provenance-tinted markers. */
      '--naksha-purple': '#9a8ce1',
      '--naksha-net-1': '#b78cff',
      '--naksha-net-2': '#ff9bb5',
      '--naksha-net-3': '#7fe7d6',
      '--naksha-dot-color': '#4e5a68',
      '--naksha-dot-hover': '#ffd700',
      '--naksha-shadow-glass': '0 8px 32px rgba(0, 0, 0, 0.4)',
      '--naksha-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.55)',
      '--breath-1': 'rgba(255, 229, 92, 0.085)',
      '--breath-2': 'rgba(255, 215, 0, 0.04)',
      '--breath-3': 'rgba(210, 188, 130, 0.035)',
      '--sky-haze': 'rgba(255, 215, 0, 0.02)',
      '--bg-gradient-top': '#090b0d',
      '--bg-gradient-bottom': '#1c2026',
    },
  },
  {
    id: 'forest-deep',
    name: 'Forest Deep',
    description: 'Deep forest greens with sage and moss — calm, grounded',
    swatch: ['#0f1612', '#5fa978', '#c8e6c9', '#a5d6a7'],
    mapLayer: 'dark',
    vars: {
      '--naksha-bg': '#0f1612',
      '--naksha-bg-2': '#141d18',
      '--naksha-bg-3': '#1a241e',
      '--naksha-glass': 'rgba(26, 36, 30, 0.72)',
      '--naksha-glass-2': 'rgba(32, 44, 36, 0.6)',
      '--naksha-glass-strong': 'rgba(15, 22, 18, 0.92)',
      '--naksha-wash': 'rgb(26, 36, 30)',
      '--naksha-scrim': 'rgb(15, 22, 18)',
      '--naksha-border': 'rgba(95, 169, 120, 0.14)',
      '--naksha-border-2': 'rgba(95, 169, 120, 0.28)',
      '--naksha-border-3': 'rgba(95, 169, 120, 0.5)',
      '--naksha-text': '#e0e8e2',
      '--naksha-text-2': '#8fa095',
      '--naksha-text-3': '#5a685f',
      '--naksha-text-4': '#3d4640',
      '--naksha-gold': '#5fa978',
      '--naksha-gold-light': '#7fc998',
      '--naksha-gold-dim': '#3d6b4d',
      '--naksha-cream': '#d4e8c9',
      '--naksha-warm': '#8fbf7f',
      '--naksha-success': '#7dba6a',
      '--naksha-error': '#d4685a',
      '--naksha-info': '#6ba8c9',
      '--naksha-warning': '#d4a85a',
      '--naksha-purple': '#9b8ec8',
      '--naksha-net-1': '#a5d6a7',
      '--naksha-net-2': '#ffb74d',
      '--naksha-net-3': '#80cbc4',
      '--naksha-dot-color': '#3a4a3f',
      '--naksha-dot-hover': '#80cbc4',
      '--naksha-shadow-glass': '0 8px 32px rgba(0, 0, 0, 0.45)',
      '--naksha-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.6)',
      '--breath-1': 'rgba(127, 201, 152, 0.07)',
      '--breath-2': 'rgba(95, 169, 120, 0.035)',
      '--breath-3': 'rgba(143, 191, 127, 0.03)',
      '--sky-haze': 'rgba(128, 203, 196, 0.022)',
      '--bg-gradient-top': '#0a100c',
      '--bg-gradient-bottom': '#1a241e',
    },
  },
  {
    id: 'ember-rose',
    name: 'Ember Rose',
    description: 'Warm rose and coral with soft cream — passionate, alive',
    swatch: ['#1a1010', '#e85d75', '#fce4ec', '#ffab91'],
    mapLayer: 'dark',
    vars: {
      '--naksha-bg': '#1a1010',
      '--naksha-bg-2': '#221616',
      '--naksha-bg-3': '#2a1c1c',
      '--naksha-glass': 'rgba(42, 28, 28, 0.72)',
      '--naksha-glass-2': 'rgba(50, 34, 34, 0.6)',
      '--naksha-glass-strong': 'rgba(26, 16, 16, 0.92)',
      '--naksha-wash': 'rgb(42, 28, 28)',
      '--naksha-scrim': 'rgb(26, 16, 16)',
      '--naksha-border': 'rgba(232, 93, 117, 0.14)',
      '--naksha-border-2': 'rgba(232, 93, 117, 0.28)',
      '--naksha-border-3': 'rgba(232, 93, 117, 0.5)',
      '--naksha-text': '#f0e0e0',
      '--naksha-text-2': '#a89090',
      '--naksha-text-3': '#6b5353',
      '--naksha-text-4': '#493838',
      '--naksha-gold': '#e85d75',
      '--naksha-gold-light': '#f58098',
      '--naksha-gold-dim': '#9d3d4d',
      '--naksha-cream': '#fce4ec',
      '--naksha-warm': '#e89a5a',
      '--naksha-success': '#7dba6a',
      '--naksha-error': '#e85d75',
      '--naksha-info': '#7ab4c2',
      '--naksha-warning': '#e8a85d',
      '--naksha-purple': '#b78cc8',
      '--naksha-net-1': '#ffab91',
      '--naksha-net-2': '#ce93d8',
      '--naksha-net-3': '#80deea',
      '--naksha-dot-color': '#5a3a3a',
      '--naksha-dot-hover': '#ffab91',
      '--naksha-shadow-glass': '0 8px 32px rgba(0, 0, 0, 0.45)',
      '--naksha-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.6)',
      '--breath-1': 'rgba(245, 128, 152, 0.085)',
      '--breath-2': 'rgba(232, 93, 117, 0.04)',
      '--breath-3': 'rgba(232, 154, 90, 0.035)',
      '--sky-haze': 'rgba(206, 147, 216, 0.022)',
      '--bg-gradient-top': '#100808',
      '--bg-gradient-bottom': '#2a1c1c',
    },
  },
  {
    id: 'ocean-abyss',
    name: 'Ocean Abyss',
    description: 'Deep teal-blue with cyan glow — vast, contemplative',
    swatch: ['#08141a', '#26c6da', '#b2ebf2', '#80deea'],
    mapLayer: 'dark',
    vars: {
      '--naksha-bg': '#08141a',
      '--naksha-bg-2': '#0e1d24',
      '--naksha-bg-3': '#142630',
      '--naksha-glass': 'rgba(20, 38, 48, 0.72)',
      '--naksha-glass-2': 'rgba(26, 46, 56, 0.6)',
      '--naksha-glass-strong': 'rgba(8, 20, 26, 0.92)',
      '--naksha-wash': 'rgb(20, 38, 48)',
      '--naksha-scrim': 'rgb(8, 20, 26)',
      '--naksha-border': 'rgba(38, 198, 218, 0.14)',
      '--naksha-border-2': 'rgba(38, 198, 218, 0.28)',
      '--naksha-border-3': 'rgba(38, 198, 218, 0.5)',
      '--naksha-text': '#e0eef2',
      '--naksha-text-2': '#8fa5b0',
      '--naksha-text-3': '#5a6e78',
      '--naksha-text-4': '#3a4a52',
      '--naksha-gold': '#26c6da',
      '--naksha-gold-light': '#4dd0e1',
      '--naksha-gold-dim': '#1a8a98',
      '--naksha-cream': '#b2ebf2',
      '--naksha-warm': '#80deea',
      '--naksha-success': '#66bb6a',
      '--naksha-error': '#ef5350',
      '--naksha-info': '#42a5f5',
      '--naksha-warning': '#ffa726',
      '--naksha-purple': '#ab47bc',
      '--naksha-net-1': '#80deea',
      '--naksha-net-2': '#ff8a65',
      '--naksha-net-3': '#a5d6a7',
      '--naksha-dot-color': '#2a4050',
      '--naksha-dot-hover': '#80deea',
      '--naksha-shadow-glass': '0 8px 32px rgba(0, 0, 0, 0.5)',
      '--naksha-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.65)',
      '--breath-1': 'rgba(77, 208, 225, 0.07)',
      '--breath-2': 'rgba(38, 198, 218, 0.035)',
      '--breath-3': 'rgba(128, 222, 234, 0.03)',
      '--sky-haze': 'rgba(66, 165, 245, 0.022)',
      '--bg-gradient-top': '#040a0e',
      '--bg-gradient-bottom': '#142630',
    },
  },
  {
    id: 'aurora-violet',
    name: 'Aurora Violet',
    description: 'Deep violet with mint accents — creative, dreamy',
    swatch: ['#140a1a', '#b388ff', '#e1bee7', '#69f0ae'],
    mapLayer: 'dark',
    vars: {
      '--naksha-bg': '#140a1a',
      '--naksha-bg-2': '#1c1024',
      '--naksha-bg-3': '#241630',
      '--naksha-glass': 'rgba(36, 22, 48, 0.72)',
      '--naksha-glass-2': 'rgba(44, 28, 56, 0.6)',
      '--naksha-glass-strong': 'rgba(20, 10, 26, 0.92)',
      '--naksha-wash': 'rgb(36, 22, 48)',
      '--naksha-scrim': 'rgb(20, 10, 26)',
      '--naksha-border': 'rgba(179, 136, 255, 0.14)',
      '--naksha-border-2': 'rgba(179, 136, 255, 0.28)',
      '--naksha-border-3': 'rgba(179, 136, 255, 0.5)',
      '--naksha-text': '#e8e0f0',
      '--naksha-text-2': '#9c90a8',
      '--naksha-text-3': '#63536b',
      '--naksha-text-4': '#42374a',
      '--naksha-gold': '#b388ff',
      '--naksha-gold-light': '#c9a8ff',
      '--naksha-gold-dim': '#7c5cb3',
      '--naksha-cream': '#e1bee7',
      '--naksha-warm': '#ce93d8',
      '--naksha-success': '#69f0ae',
      '--naksha-error': '#ff5377',
      '--naksha-info': '#40c4ff',
      '--naksha-warning': '#ffd54f',
      '--naksha-purple': '#b388ff',
      '--naksha-net-1': '#ce93d8',
      '--naksha-net-2': '#69f0ae',
      '--naksha-net-3': '#40c4ff',
      '--naksha-dot-color': '#3a2a48',
      '--naksha-dot-hover': '#69f0ae',
      '--naksha-shadow-glass': '0 8px 32px rgba(0, 0, 0, 0.5)',
      '--naksha-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.65)',
      '--breath-1': 'rgba(201, 168, 255, 0.085)',
      '--breath-2': 'rgba(179, 136, 255, 0.04)',
      '--breath-3': 'rgba(206, 147, 216, 0.035)',
      '--sky-haze': 'rgba(64, 196, 255, 0.022)',
      '--bg-gradient-top': '#0a0410',
      '--bg-gradient-bottom': '#241630',
    },
  },
  {
    id: 'sand-dune',
    name: 'Sand Dune',
    description: 'Warm desert sand with terracotta — earthy, serene',
    swatch: ['#1a1410', '#d4a574', '#ffe0b2', '#ffab91'],
    mapLayer: 'dark',
    vars: {
      '--naksha-bg': '#1a1410',
      '--naksha-bg-2': '#221a14',
      '--naksha-bg-3': '#2a2018',
      '--naksha-glass': 'rgba(42, 32, 24, 0.72)',
      '--naksha-glass-2': 'rgba(50, 38, 28, 0.6)',
      '--naksha-glass-strong': 'rgba(26, 20, 16, 0.92)',
      '--naksha-wash': 'rgb(42, 32, 24)',
      '--naksha-scrim': 'rgb(26, 20, 16)',
      '--naksha-border': 'rgba(212, 165, 116, 0.14)',
      '--naksha-border-2': 'rgba(212, 165, 116, 0.28)',
      '--naksha-border-3': 'rgba(212, 165, 116, 0.5)',
      '--naksha-text': '#f0e8e0',
      '--naksha-text-2': '#a89a8a',
      '--naksha-text-3': '#6b5f53',
      '--naksha-text-4': '#49413a',
      '--naksha-gold': '#d4a574',
      '--naksha-gold-light': '#e8b888',
      '--naksha-gold-dim': '#8a6d4d',
      '--naksha-cream': '#ffe0b2',
      '--naksha-warm': '#c8a472',
      '--naksha-success': '#7dba6a',
      '--naksha-error': '#c05b4d',
      '--naksha-info': '#7ab4c2',
      '--naksha-warning': '#d4a574',
      /* Task 91 — set to the shared heritage violet (#9a8ce1): the old
         value #9b7ec8 equals TAG_COLORS.purple exactly, and tagged-vs-
         untagged markers would collide on this theme's map. */
      '--naksha-purple': '#9a8ce1',
      '--naksha-net-1': '#ffab91',
      '--naksha-net-2': '#bcaaa4',
      '--naksha-net-3': '#a5d6a7',
      '--naksha-dot-color': '#4a3e34',
      '--naksha-dot-hover': '#ffab91',
      '--naksha-shadow-glass': '0 8px 32px rgba(0, 0, 0, 0.4)',
      '--naksha-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.55)',
      '--breath-1': 'rgba(232, 184, 136, 0.085)',
      '--breath-2': 'rgba(212, 165, 116, 0.04)',
      '--breath-3': 'rgba(200, 164, 114, 0.035)',
      '--sky-haze': 'rgba(255, 171, 145, 0.022)',
      '--bg-gradient-top': '#100c08',
      '--bg-gradient-bottom': '#2a2018',
    },
  },
  {
    id: 'ocean-night',
    name: 'Ocean Night',
    description: 'Deep midnight blue with sky-blue glow — city lights in fog, seen from a peak',
    swatch: ['#020617', '#38bdf8', '#94a3b8', '#0f172a'],
    mapLayer: 'dark',
    vars: {
      '--naksha-bg': '#020617',
      '--naksha-bg-2': '#06101f',
      '--naksha-bg-3': '#0a1628',
      '--naksha-glass': 'rgba(15, 23, 42, 0.6)',
      '--naksha-glass-2': 'rgba(15, 23, 42, 0.5)',
      '--naksha-glass-strong': 'rgba(2, 6, 23, 0.88)',
      '--naksha-wash': 'rgb(15, 23, 42)',
      '--naksha-scrim': 'rgb(2, 6, 23)',
      '--naksha-border': 'rgba(56, 189, 248, 0.1)',
      '--naksha-border-2': 'rgba(56, 189, 248, 0.22)',
      '--naksha-border-3': 'rgba(56, 189, 248, 0.45)',
      '--naksha-text': '#cbd5e1',
      '--naksha-text-2': '#94a3b8',
      '--naksha-text-3': '#64748b',
      '--naksha-text-4': '#475569',
      '--naksha-gold': '#38bdf8',
      '--naksha-gold-light': '#7dd3fc',
      '--naksha-gold-dim': '#0284c7',
      '--naksha-cream': '#e0f2fe',
      '--naksha-warm': '#7dd3fc',
      '--naksha-success': '#34d399',
      '--naksha-error': '#f87171',
      '--naksha-info': '#60a5fa',
      '--naksha-warning': '#fbbf24',
      '--naksha-purple': '#a78bfa',
      '--naksha-net-1': '#a78bfa',
      '--naksha-net-2': '#f472b6',
      '--naksha-net-3': '#34d399',
      '--naksha-dot-color': 'rgba(148, 163, 184, 0.12)',
      '--naksha-dot-hover': '#38bdf8',
      '--naksha-shadow-glass': '0 8px 32px rgba(0, 0, 0, 0.5)',
      '--naksha-shadow-elevated': '0 12px 48px rgba(0, 0, 0, 0.65)',
      '--breath-1': 'rgba(56, 189, 248, 0.07)',
      '--breath-2': 'rgba(125, 211, 252, 0.035)',
      '--breath-3': 'rgba(96, 165, 250, 0.03)',
      '--sky-haze': 'rgba(56, 189, 248, 0.022)',
      '--bg-gradient-top': '#020617',
      '--bg-gradient-bottom': '#0a1628',
    },
  },
  {
    id: 'warm-light',
    name: 'Warm Light',
    description: 'Warm paper white with sepia accents — easy on eyes in bright rooms',
    swatch: ['#f5f0e8', '#8a6d1a', '#3a3530', '#d4a017'],
    mapLayer: 'standard',
    vars: {
      '--naksha-bg': '#f5f0e8',
      '--naksha-bg-2': '#ede5d8',
      '--naksha-bg-3': '#e0d5c4',
      '--naksha-glass': 'rgba(255, 250, 240, 0.72)',
      '--naksha-glass-2': 'rgba(245, 235, 220, 0.6)',
      '--naksha-glass-strong': 'rgba(245, 240, 232, 0.92)',
      /* Light papers: the wash lifts (the glass family IS near-white),
       * and the scrim dims with the theme's own warm ink instead of the
       * amber-night warm-black. */
      '--naksha-wash': 'rgb(255, 250, 240)',
      '--naksha-scrim': 'rgb(42, 37, 32)',
      '--naksha-border': 'rgba(138, 109, 26, 0.15)',
      '--naksha-border-2': 'rgba(138, 109, 26, 0.3)',
      '--naksha-border-3': 'rgba(138, 109, 26, 0.5)',
      '--naksha-text': '#2a2520',
      '--naksha-text-2': '#5a5048',
      '--naksha-text-3': '#8a8070',
      /* Task 96 — the faint tier was tuned fainter than readable on its
       * own paper (1.9:1 in the footer sweep): #98907c lands the tier at
       * ~2.7:1 — still the faintest voice, now actually legible. */
      '--naksha-text-4': '#98907c',
      '--naksha-gold': '#8a6d1a',
      '--naksha-gold-light': '#a8821e',
      '--naksha-gold-dim': '#c4a35a',
      '--naksha-cream': '#3a3530',
      '--naksha-warm': '#c4a35a',
      '--naksha-success': '#5a8a4a',
      '--naksha-error': '#a0453d',
      '--naksha-info': '#4a7a9c',
      '--naksha-warning': '#8a6d1a',
      '--naksha-purple': '#7a5a9c',
      '--naksha-net-1': '#7a5a9c',
      '--naksha-net-2': '#a0453d',
      '--naksha-net-3': '#4a8a7a',
      '--naksha-dot-color': 'rgba(90, 80, 72, 0.15)',
      '--naksha-dot-hover': '#8a6d1a',
      '--naksha-shadow-glass': '0 4px 20px rgba(80, 70, 50, 0.12)',
      '--naksha-shadow-elevated': '0 8px 32px rgba(80, 70, 50, 0.18)',
      '--breath-1': 'rgba(196, 163, 90, 0.06)',
      '--breath-2': 'rgba(138, 109, 26, 0.03)',
      '--breath-3': 'rgba(196, 163, 90, 0.025)',
      '--sky-haze': 'rgba(74, 122, 156, 0.02)',
      '--bg-gradient-top': '#faf6ee',
      '--bg-gradient-bottom': '#e0d5c4',
    },
  },
  {
    id: 'cool-light',
    name: 'Cool Light',
    description: 'Clean cool gray-blue with steel accents — professional, calm',
    swatch: ['#f0f2f5', '#3b82f6', '#334155', '#64748b'],
    mapLayer: 'standard',
    vars: {
      '--naksha-bg': '#f0f2f5',
      '--naksha-bg-2': '#e8ebf0',
      '--naksha-bg-3': '#d8dde5',
      '--naksha-glass': 'rgba(255, 255, 255, 0.72)',
      '--naksha-glass-2': 'rgba(240, 245, 250, 0.6)',
      '--naksha-glass-strong': 'rgba(248, 250, 252, 0.92)',
      '--naksha-wash': 'rgb(255, 255, 255)',
      '--naksha-scrim': 'rgb(30, 41, 59)',
      '--naksha-border': 'rgba(59, 130, 246, 0.12)',
      '--naksha-border-2': 'rgba(59, 130, 246, 0.25)',
      '--naksha-border-3': 'rgba(59, 130, 246, 0.45)',
      '--naksha-text': '#1e293b',
      '--naksha-text-2': '#475569',
      '--naksha-text-3': '#64748b',
      /* Task 96 — same tier rescue as warm-light: ~2.9:1 on cool paper. */
      '--naksha-text-4': '#8290a4',
      '--naksha-gold': '#3b82f6',
      '--naksha-gold-light': '#60a5fa',
      '--naksha-gold-dim': '#2563eb',
      '--naksha-cream': '#1e293b',
      '--naksha-warm': '#64748b',
      '--naksha-success': '#16a34a',
      '--naksha-error': '#dc2626',
      '--naksha-info': '#2563eb',
      '--naksha-warning': '#d97706',
      '--naksha-purple': '#7c3aed',
      '--naksha-net-1': '#7c3aed',
      '--naksha-net-2': '#ec4899',
      '--naksha-net-3': '#14b8a6',
      '--naksha-dot-color': 'rgba(100, 116, 139, 0.12)',
      '--naksha-dot-hover': '#3b82f6',
      '--naksha-shadow-glass': '0 4px 20px rgba(30, 41, 59, 0.1)',
      '--naksha-shadow-elevated': '0 8px 32px rgba(30, 41, 59, 0.15)',
      '--breath-1': 'rgba(96, 165, 250, 0.05)',
      '--breath-2': 'rgba(59, 130, 246, 0.025)',
      '--breath-3': 'rgba(100, 116, 139, 0.02)',
      '--sky-haze': 'rgba(124, 58, 237, 0.018)',
      '--bg-gradient-top': '#f8fafc',
      '--bg-gradient-bottom': '#d8dde5',
    },
  },
];

export const DEFAULT_THEME_ID = 'amber-night';

export function getTheme(id: string): NakshaTheme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/** The basemap that fits a theme (falls back to ESRI dark for unknown ids). */
export function getThemeMapLayer(id: string): MapLayerKey {
  return getTheme(id).mapLayer ?? 'dark';
}

/**
 * shadcn/ui token bridge (Task 32 — REAL BUG fix).
 *
 * The app's Tailwind/shadcn components (CommandDialog palettes, dropdowns,
 * popovers, tooltips) consume the shadcn token set (`--background`,
 * `--popover`, `--accent`, …). globals.css only ever defined LIGHT defaults
 * for them inside :root, and the `.dark` override block was never activated
 * (no `dark` class on <html>) — so every palette/dialog rendered WHITE
 * inside the warm-dark app. The palette's outer frame was darkened by
 * JumpStyles' scoped override, but its inner `bg-popover` wrapper filled
 * white on top.
 *
 * Fix: derive the shadcn tokens FROM each theme's own surfaces and apply
 * them as inline :root styles in applyTheme() — JS-driven, so the frozen
 * dev CSS pipeline cannot eat them, and every theme stays coherent.
 */
function deriveUiTokens(theme: NakshaTheme): Record<string, string> {
  const bg = theme.vars['--naksha-bg'];
  const bg2 = theme.vars['--naksha-bg-2'];
  const bg3 = theme.vars['--naksha-bg-3'];
  const text = theme.vars['--naksha-text'];
  const text2 = theme.vars['--naksha-text-2'];
  const border = theme.vars['--naksha-border-2'];
  const gold = theme.vars['--naksha-gold'];
  const error = theme.vars['--naksha-error'];
  const isLight = theme.id.endsWith('-light');
  return {
    '--background': bg,
    '--foreground': text,
    '--card': bg2,
    '--card-foreground': text,
    /* Dialogs/popovers use the mid warm surface (matches glass-strong's
       family) rather than pure bg — visually "a pane above the app". */
    '--popover': bg2,
    '--popover-foreground': text,
    '--primary': gold,
    /* v138 T3 — was the frozen amber-night bg '#1a1611' for ALL dark
     * themes; now each dark theme wears its own bg (amber-night resolves
     * to its re-toned #0e1013, forest to its own — same near-black read,
     * correct per paper). */
    '--primary-foreground': isLight ? '#ffffff' : bg,
    '--secondary': bg3,
    '--secondary-foreground': text,
    '--muted': bg3,
    '--muted-foreground': text2,
    /* cmdk uses --accent for hover/selected rows. */
    '--accent': bg3,
    '--accent-foreground': text,
    '--destructive': error,
    '--border': border,
    '--input': border,
    '--ring': gold,
  };
}

/**
 * Apply a theme by setting CSS variables on :root.
 * Called on app init and whenever the user switches themes.
 */
export function applyTheme(id: string): void {
  const theme = getTheme(id);
  const root = document.documentElement;
  for (const [key, value] of Object.entries(theme.vars)) {
    root.style.setProperty(key, value);
  }
  /* shadcn token bridge — see deriveUiTokens above. */
  for (const [key, value] of Object.entries(deriveUiTokens(theme))) {
    root.style.setProperty(key, value);
  }
  root.setAttribute('data-theme', theme.id);
}

/* Task 91 — the violet ACCENT, resolved per theme. Before this round the
 * accent was a fleet of frozen literals (#9a8ce1 / #9b7ec8 fallbacks)
 * while every theme declared a tuned --naksha-purple nobody read. The
 * DOM surfaces now ride var(--naksha-purple) / color-mix() directly, but
 * Canvas2D can't parse either — so canvas surfaces (the tree's ◈ badge,
 * the graph's located-node halos) call this: one getComputedStyle read
 * per THEME (cached on the html[data-theme] attribute applyTheme sets),
 * never per frame. The #9a8ce1 fallback is the heritage hue the markers
 * always rendered — it also covers SSR (no document) and the pre-init
 * frame before applyTheme runs (the :root default is the same value). */
let accentCache: { theme: string; value: string } = { theme: '', value: '#9a8ce1' };

export function accentPurple(): string {
  if (typeof document === 'undefined') return accentCache.value;
  const t = document.documentElement.getAttribute('data-theme') ?? '';
  if (t !== accentCache.theme) {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--naksha-purple').trim();
    accentCache = { theme: t, value: v || '#9a8ce1' };
  }
  return accentCache.value;
}

/* Task 94 — the canvas INK family, resolved per theme. The Task 91 audit
 * question ("do canvas inks ride the theme beyond the violet?") closes
 * with field evidence: the tree/graph label trio froze amber-night's
 * palette — #a89e88 IS amber's --naksha-text-2, #6b6353 IS its text-3,
 * #f0c040 IS its gold-light — readable on warm dark, washed on light
 * papers (≈2.3:1 and ≈1.9:1 on warm-light's cream). The resting INK
 * (always-on labels) rides the theme; the momentary hover lifts and the
 * decorative alpha washes stay frozen (they read on both families).
 * Same contract as accentPurple: one getComputedStyle read per THEME
 * (cached on html[data-theme]), never per frame — the "kept inline for
 * canvas performance" concern the old palette comment raised. The
 * fallbacks are amber-night's own values, so SSR / pre-init / any theme
 * that skips a var render exactly as yesterday. */
export interface CanvasInk {
  text2: string;
  text3: string;
  goldLight: string;
  /* Task 115 — the quiet accent voice joins the kit: the graph's tree-edge
   * family (the resting/dim texture lines) rode the OLD pre-token amber
   * #d4a017 frozen; goldDim is the token the design system declares for
   * exactly this "quiet accent" role, so the tree edges now follow the
   * theme's own dim voice (on light papers bright goldLight washed out
   * at rest — goldDim is built for it). */
  goldDim: string;
  /* Task 117 — the label HOVER LIFTS join the kit. Task 94 froze them
   * (amber-night's lit gold #f6cf5a / bright bone #d6cbb4) as "momentary,
   * reads on both families" — but with the whole accent system themed
   * (Tasks 94–116), a hover flash in amber-night's gold reads as a stray
   * on every other paper, and on light papers "brighter" is the WRONG
   * polarity anyway (the ink must step darker to gain contrast). The fix
   * is computed, not a new fleet of hand-tuned vars: each lift is the
   * resting ink MIXED TOWARD the theme's strongest text ink (--naksha-
   * text). On dark papers text is brighter → the lift brightens; on
   * light papers text is darker → the lift deepens. One rule, correct
   * polarity everywhere, hue stays in the theme's own family. Amber-
   * night parity: text2→text @0.7 ≈ #d5ccba vs the frozen #d6cbb4
   * (near-identical); goldLight→text @0.3 ≈ #eeca6b vs #f6cf5a (same
   * lit-gold read). The fallbacks below ARE the frozen heritage values,
   * so SSR / pre-init render exactly as before. */
  goldLift: string;
  textLift: string;
}

/* The fallbacks are amber-night's own values — re-synced by the v138 T3
 * metallic re-tone (gunmetal paper, shiny gold ink) so SSR / pre-init
 * render exactly what the default theme now declares. */
const inkFallback: CanvasInk = {
  text2: '#9aa3b2',
  text3: '#5d6673',
  goldLight: '#ffe55c',
  goldDim: '#8f7514',
  goldLift: '#f8e788',
  textLift: '#d0d5dd',
};

/* Task 117 — hex↔hex lerp for the computed lifts. Channel-linear mix
 * (the same math color-mix() uses in srgb); both inputs must be #rgb or
 * #rrggbb — every --naksha-* color var in this codebase is. Malformed
 * input falls back to `b` at t=0 → the resting ink unchanged, i.e. a
 * missing --naksha-text simply degrades the lift to "no lift", never to
 * a wrong color. */
export function hexMix(a: string, b: string, t: number): string {
  const parse = (hex: string): [number, number, number] | null => {
    const h = hex.replace('#', '');
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
  };
  const ca = parse(a);
  const cb = parse(b);
  if (!ca || !cb) return a;
  const k = Math.max(0, Math.min(1, t));
  const ch = (x: number, y: number) => Math.round(x + (y - x) * k).toString(16).padStart(2, '0');
  return `#${ch(ca[0], cb[0])}${ch(ca[1], cb[1])}${ch(ca[2], cb[2])}`;
}

let inkCache: { theme: string; ink: CanvasInk } = { theme: '', ink: inkFallback };

export function canvasInk(): CanvasInk {
  if (typeof document === 'undefined') return inkCache.ink;
  const t = document.documentElement.getAttribute('data-theme') ?? '';
  if (t !== inkCache.theme) {
    const cs = getComputedStyle(document.documentElement);
    const read = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
    const text2 = read('--naksha-text-2', inkFallback.text2);
    const goldLight = read('--naksha-gold-light', inkFallback.goldLight);
    const text = read('--naksha-text', '');
    /* Task 117 — the lifts mix toward the family's strongest ink. If
     * --naksha-text is unreadable (shouldn't happen — every theme
     * declares it), keep the heritage frozen lifts so the hover moment
     * still reads. */
    const goldLift = text ? hexMix(goldLight, text, 0.3) : inkFallback.goldLift;
    const textLift = text ? hexMix(text2, text, 0.7) : inkFallback.textLift;
    inkCache = {
      theme: t,
      ink: {
        text2,
        text3: read('--naksha-text-3', inkFallback.text3),
        goldLight,
        goldDim: read('--naksha-gold-dim', inkFallback.goldDim),
        goldLift,
        textLift,
      },
    };
  }
  return inkCache.ink;
}
