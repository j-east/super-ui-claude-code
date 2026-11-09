// Themes: UI colors (CSS variables) + matching xterm theme. Add one by adding an entry.
export const THEMES = {
  'claude-dark': {
    label: 'Claude Dark', dark: true,
    ui: { bg: '#262624', panel: '#1f1e1d', text: '#e8e6dc', muted: '#9c9a92', line: '#3a3936',
      accent: '#d97757', user: '#30302e', code: '#1a1a19', ok: '#7fb069', err: '#e06c5f' },
    term: { background: '#1a1a19', foreground: '#e8e6dc', cursor: '#d97757', selectionBackground: '#4a4844' },
  },
  'claude-light': {
    label: 'Claude Light', dark: false,
    ui: { bg: '#faf9f5', panel: '#f0eee6', text: '#29261b', muted: '#73726c', line: '#dedcd1',
      accent: '#c96442', user: '#ebe8dd', code: '#f3f1ea', ok: '#4d7c3a', err: '#b9412f' },
    term: { background: '#f3f1ea', foreground: '#29261b', cursor: '#c96442', selectionBackground: '#d9d4c3' },
  },
  midnight: {
    label: 'Midnight', dark: true,
    ui: { bg: '#0f1420', panel: '#0b0f18', text: '#d6deeb', muted: '#7f8ba3', line: '#1f2a3d',
      accent: '#82aaff', user: '#1a2335', code: '#0b0f18', ok: '#addb67', err: '#ef5350' },
    term: { background: '#0b0f18', foreground: '#d6deeb', cursor: '#82aaff', selectionBackground: '#1d3b53' },
  },
  solarized: {
    label: 'Solarized Dark', dark: true,
    ui: { bg: '#002b36', panel: '#00252f', text: '#a3b1b1', muted: '#657b83', line: '#0d4150',
      accent: '#b58900', user: '#073642', code: '#00212b', ok: '#859900', err: '#dc322f' },
    term: { background: '#00212b', foreground: '#a3b1b1', cursor: '#b58900', selectionBackground: '#174652' },
  },
  gruvbox: {
    label: 'Gruvbox', dark: true,
    ui: { bg: '#282828', panel: '#1d2021', text: '#ebdbb2', muted: '#a89984', line: '#3c3836',
      accent: '#fe8019', user: '#32302f', code: '#1d2021', ok: '#b8bb26', err: '#fb4934' },
    term: { background: '#1d2021', foreground: '#ebdbb2', cursor: '#fe8019', selectionBackground: '#504945' },
  },
  forest: {
    label: 'Forest', dark: true,
    ui: { bg: '#1b2420', panel: '#151c19', text: '#dfe8df', muted: '#8fa396', line: '#2c3a33',
      accent: '#7ec699', user: '#243029', code: '#131916', ok: '#a6d189', err: '#e78284' },
    term: { background: '#131916', foreground: '#dfe8df', cursor: '#7ec699', selectionBackground: '#33463c' },
  },
  synthwave: {
    label: 'Synthwave', dark: true,
    ui: { bg: '#1e1631', panel: '#170f28', text: '#f4eeff', muted: '#a59bc4', line: '#34295a',
      accent: '#ff4fd8', user: '#2a1f47', code: '#140c24', ok: '#72f1b8', err: '#fe4450' },
    term: { background: '#140c24', foreground: '#f4eeff', cursor: '#ff4fd8', selectionBackground: '#3d2f66' },
  },
  paper: {
    label: 'Paper (high contrast)', dark: false,
    ui: { bg: '#ffffff', panel: '#f2f2f2', text: '#111111', muted: '#555555', line: '#d0d0d0',
      accent: '#0057d9', user: '#eef3fb', code: '#f6f6f6', ok: '#1a7f37', err: '#cf222e' },
    term: { background: '#fbfbfb', foreground: '#111111', cursor: '#0057d9', selectionBackground: '#cfe0fb' },
  },
};

export const DEFAULT_THEME = 'claude-dark';

export function applyTheme(name, terms) {
  const t = THEMES[name] ?? THEMES[DEFAULT_THEME];
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(t.ui)) root.setProperty(`--${k}`, v);
  document.documentElement.dataset.mode = t.dark ? 'dark' : 'light';
  document.getElementById('hljs-css').href = t.dark ? '/vendor/hljs-dark.css' : '/vendor/hljs-light.css';
  for (const term of terms) term.options.theme = t.term;
  return t;
}
