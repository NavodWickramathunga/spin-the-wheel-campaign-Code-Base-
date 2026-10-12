// Mystery gift box: pick 1 of 3 boxes; it opens to show the prize the server picked.
// The other boxes are only dimmed, never "revealed" - the result doesn't depend on the box chosen.
module.exports = {
  id: 'gift-box',
  title: 'Pick a Gift!',
  config: `
    mainTitle: { text: "Pick a <span class='hl'>Gift!</span>", fontSize: "24px" },
    subtitle: { text: "One tap could unwrap your reward. Choose a box!", fontSize: "13.5px" },
    button: { text: "Pick one for me", busyText: "Unwrapping...", style: "ghost" },
    hintText: "Tap a box to open it",`,
  css: `
  .boxes { display: flex; justify-content: center; gap: 10px; padding: 46px 12px 14px; border-radius: 20px; background: #fff;
    box-shadow: 0 14px 34px -10px rgba(17, 24, 39, .35); }
  .gbox { color: var(--ink); position: relative; flex: 1; max-width: 86px; aspect-ratio: 1 / 1.05; padding: 0; border: 0; background: none; cursor: pointer; font: inherit; }
  .gbox:disabled { cursor: default; color: var(--ink); } /* disabled buttons grey out text, which also fades colour emoji */
  .gift { position: absolute; inset: 0; transform-origin: 50% 100%; animation: bob 2.4s ease-in-out infinite; animation-delay: calc(var(--i) * .35s); }
  .gbody { position: absolute; left: 6%; right: 6%; top: 34%; bottom: 0; border-radius: 6px;
    background: linear-gradient(160deg, var(--brand), var(--brand-dark)); box-shadow: inset 0 -6px 0 rgba(0, 0, 0, .12); }
  .gbody::before, .lid::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 18%; transform: translateX(-50%); background: var(--accent); }
  .lid { position: absolute; left: 0; right: 0; top: 16%; height: 22%; z-index: 2; border-radius: 6px;
    background: linear-gradient(160deg, var(--brand), var(--brand-dark)); box-shadow: 0 3px 0 rgba(0, 0, 0, .14);
    transition: transform .6s cubic-bezier(.3, 1.4, .5, 1), opacity .5s ease .1s; }
  .bow { position: absolute; left: 50%; top: 0; width: 46%; height: 20%; transform: translateX(-50%); }
  .bow::before, .bow::after { content: ""; position: absolute; bottom: 0; width: 50%; height: 100%; border: 4px solid var(--accent); border-radius: 50% 50% 10% 50%; }
  .bow::before { left: 0; transform: rotate(-20deg); }
  .bow::after { right: 0; transform: rotate(20deg) scaleX(-1); }
  .gbox.shake .gift { animation: shakeBox .45s ease-in-out infinite; }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
  @keyframes shakeBox { 25% { transform: rotate(-7deg); } 75% { transform: rotate(7deg); } }
  .gbox.open .gift { animation: none; }
  .gbox.open .lid, .gbox.open .bow { transform: translate(-10%, -150%) rotate(-28deg); opacity: 0; }
  .gbox.open .bow { transition: transform .6s cubic-bezier(.3, 1.4, .5, 1), opacity .5s ease .1s; }
  .gprize { position: absolute; left: -12px; right: -12px; top: 0; z-index: 3; display: flex; flex-direction: column; align-items: center; gap: 4px;
    opacity: 0; transform: translateY(24px) scale(.5); pointer-events: none; transition: opacity .4s ease .15s, transform .55s cubic-bezier(.3, 1.5, .5, 1) .15s; }
  .gbox.open .gprize { opacity: 1; transform: translateY(-34px) scale(1); }
  .gprize .pi { font-size: 32px; line-height: 1; filter: drop-shadow(0 3px 4px rgba(0, 0, 0, .2)); }
  .gprize .pn { padding: 3px 7px; border-radius: 7px; font-size: 11px; font-weight: 800; line-height: 1.15; color: #fff; background: var(--brand);
    box-shadow: 0 3px 8px rgba(var(--brand-rgb), .35); }
  .gprize.lose .pn { color: var(--ink-2); background: var(--surface); box-shadow: inset 0 0 0 1px var(--line); }
  .gbox.dim { opacity: .35; filter: grayscale(.7); transition: opacity .4s, filter .4s; }
  .gbox.dim .gift { animation: none; }`,
  html: `
        <div class="boxes" id="boxes"></div>`,
  js: `
  const GAME = (function () {
    let c, boxes = [], busy = false;
    async function pick(i) {
      if (busy || !c.canPlay()) return;
      busy = true;
      boxes.forEach((b) => (b.disabled = true));
      const box = boxes[i];
      box.classList.add('shake');
      c.setHint('');
      const data = await c.play();
      if (!data) { box.classList.remove('shake'); boxes.forEach((b) => (b.disabled = false)); busy = false; c.setHint(c.config.hintText); return; }
      await c.wait(600);
      box.classList.remove('shake');
      const r = c.rewardFor(data), prize = box.querySelector('.gprize');
      prize.classList.toggle('lose', !data.won);
      prize.querySelector('.pi').textContent = c.iconFor(r);
      prize.querySelector('.pn').textContent = data.won ? r.name : 'No luck';
      box.classList.add('open');
      boxes.forEach((b) => { if (b !== box) b.classList.add('dim'); });
      c.buzz(20);
      c.setHint(data.won ? 'You unwrapped a reward!' : 'Not this time - thanks for playing!');
      await c.wait(1400);
      c.finish(data);
    }
    return {
      init(ctx) {
        c = ctx;
        const wrap = c.$('boxes');
        for (let i = 0; i < 3; i++) {
          const b = document.createElement('button');
          b.className = 'gbox'; b.style.setProperty('--i', i); b.setAttribute('aria-label', 'Gift box ' + (i + 1));
          b.innerHTML = '<div class="gift"><div class="gbody"></div><div class="lid"></div><div class="bow"></div></div>' +
            '<div class="gprize"><span class="pi"></span><span class="pn"></span></div>';
          b.addEventListener('click', () => pick(i));
          wrap.appendChild(b); boxes.push(b);
        }
      },
      onButton() { pick(Math.floor(Math.random() * boxes.length)); },
    };
  })();`,
};
