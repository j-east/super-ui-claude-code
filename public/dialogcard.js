// A question Claude Code is asking (permission prompt, AskUserQuestion, folder trust…) as a card:
// the full question, every option with its description, and buttons that answer it. Shown at the
// bottom of the tab's transcript and in the inbox. The server parses the dialog off the terminal
// screen and turns a click back into the right keys.

const h = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * @param {{ steps: {name: string, done: boolean}[], text: string, multi: boolean, sig: string,
 *           options: {n: number|null, label: string, desc: string, checked: boolean|null, current: boolean}[] }} d
 * @param {{ onPick: (index: number) => void, onCancel: () => void, onType?: () => void }} act
 */
export function dialogCard(d, act) {
  const card = h('div', 'dlg');
  if (d.steps.length > 1) {
    const steps = h('div', 'dlg-steps');
    const cur = d.steps.findIndex((s) => !s.done);
    d.steps.forEach((s, i) => steps.append(h('span', 'dlg-step' + (s.done ? ' done' : i === cur ? ' cur' : ''), `${s.done ? '✓ ' : ''}${s.name}`)));
    card.append(steps);
  }
  card.append(h('div', 'dlg-text', d.text));
  if (d.multi) card.append(h('div', 'dlg-hint', 'Pick any number, then Submit.'));
  const list = h('div', 'dlg-opts');
  d.options.forEach((o, i) => {
    const b = h('button', 'dlg-opt' + (o.checked ? ' checked' : '') + (o.label === 'Submit' && o.n === null && d.multi ? ' submit' : ''));
    const key = h('span', 'dlg-key', o.checked !== null ? (o.checked ? '☑' : '☐') : o.n !== null ? String(o.n) : '›');
    const body = h('span', 'dlg-body');
    body.append(h('span', 'dlg-label', o.label));
    if (o.desc) body.append(h('span', 'dlg-desc', o.desc));
    b.append(key, body);
    b.addEventListener('click', () => {
      if (card.classList.contains('sent') && !d.multi) return;
      card.classList.add('sent');
      act.onPick(i);
      if (/^Type something|tell Claude what to do/i.test(o.label)) act.onType?.(); // continues in the terminal
    });
    list.append(b);
  });
  card.append(list);
  const foot = h('div', 'dlg-foot');
  const cancel = h('button', 'dlg-cancel', 'Cancel (Esc)');
  cancel.addEventListener('click', () => act.onCancel());
  foot.append(cancel);
  card.append(foot);
  return card;
}
