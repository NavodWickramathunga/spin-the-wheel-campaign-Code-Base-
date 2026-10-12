// Flip the card: pick 1 of 6 face-down cards; it flips to show the prize the server picked.
// The other cards are only dimmed, never flipped - the result doesn't depend on the card chosen.
module.exports = {
  id: 'flip-card',
  title: 'Flip & Win!',
  config: `
    mainTitle: { text: "Flip &amp; <span class='hl'>Win!</span>", fontSize: "24px" },
    subtitle: { text: "Pick a card and flip it to see what you've won.", fontSize: "13.5px" },
    button: { text: "Pick one for me", busyText: "Flipping...", style: "ghost" },
    hintText: "Tap a card to flip it",`,
  css: `
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; padding: 14px; border-radius: 20px; background: #fff;
    box-shadow: 0 14px 34px -10px rgba(17, 24, 39, .35); }
  .fcard { color: var(--ink); position: relative; aspect-ratio: 3 / 4; padding: 0; border: 0; background: none; cursor: pointer; font: inherit; perspective: 600px;
    animation: deal .5s var(--ease) both; animation-delay: calc(var(--i) * .07s + .35s); }
  .fcard:disabled { cursor: default; color: var(--ink); } /* disabled buttons grey out text, which also fades colour emoji */
  @keyframes deal { from { opacity: 0; transform: translateY(14px) scale(.9); } }
  .fcard .in { position: absolute; inset: 0; transform-style: preserve-3d; transition: transform .7s cubic-bezier(.3, 1.25, .5, 1); }
  .fcard.flipped .in { transform: rotateY(180deg); }
  .fcard.wait .in { animation: lift .8s ease-in-out infinite; }
  @keyframes lift { 50% { transform: translateY(-6px) rotate(-3deg); } }
  .face { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 6px;
    border-radius: 12px; -webkit-backface-visibility: hidden; backface-visibility: hidden; }
  .back { overflow: hidden; color: #fff; background: linear-gradient(150deg, var(--brand), var(--brand-dark)); box-shadow: 0 6px 14px -6px rgba(var(--brand-rgb), .6); }
  .back::before { content: ""; position: absolute; inset: 6px; border-radius: 8px; border: 1.5px solid rgba(255, 255, 255, .35);
    background: radial-gradient(rgba(255, 255, 255, .18) 1px, transparent 1.5px) 0 0 / 10px 10px; }
  .back b { position: relative; font-size: 26px; font-weight: 800; color: var(--accent); }
  .front { transform: rotateY(180deg); background: #fff; border: 2px solid rgba(var(--brand-rgb), .35); }
  .front .pi { font-size: 28px; line-height: 1; }
  .front .pn { font-size: 11px; font-weight: 800; line-height: 1.2; color: var(--brand); }
  .front.lose .pn { color: var(--ink-2); }
  .fcard.chosen .front { box-shadow: 0 0 0 3px var(--accent), 0 10px 20px -8px rgba(var(--brand-rgb), .6); }
  .fcard.dim { opacity: .35; transition: opacity .4s; }`,
  html: `
        <div class="cards" id="cards"></div>`,
  js: `
  const GAME = (function () {
    let c, cards = [], busy = false;
    async function pick(i) {
      if (busy || !c.canPlay()) return;
      busy = true;
      cards.forEach((x) => (x.disabled = true));
      const card = cards[i];
      card.classList.add('wait', 'chosen');
      c.setHint('');
      const data = await c.play();
      if (!data) { card.classList.remove('wait', 'chosen'); cards.forEach((x) => (x.disabled = false)); busy = false; c.setHint(c.config.hintText); return; }
      await c.wait(400);
      const r = c.rewardFor(data), front = card.querySelector('.front');
      front.classList.toggle('lose', !data.won);
      front.querySelector('.pi').textContent = c.iconFor(r);
      front.querySelector('.pn').textContent = data.won ? r.name : 'Better luck next time';
      card.classList.remove('wait');
      card.classList.add('flipped');
      cards.forEach((x) => { if (x !== card) x.classList.add('dim'); });
      c.buzz(20);
      c.setHint(data.won ? 'You found a reward!' : 'Not this time - thanks for playing!');
      await c.wait(1500);
      c.finish(data);
    }
    return {
      init(ctx) {
        c = ctx;
        const wrap = c.$('cards');
        for (let i = 0; i < 6; i++) {
          const b = document.createElement('button');
          b.className = 'fcard'; b.style.setProperty('--i', i); b.setAttribute('aria-label', 'Card ' + (i + 1));
          b.innerHTML = '<div class="in"><div class="face back"><b>?</b></div><div class="face front"><span class="pi"></span><span class="pn"></span></div></div>';
          b.addEventListener('click', () => pick(i));
          wrap.appendChild(b); cards.push(b);
        }
      },
      onButton() { pick(Math.floor(Math.random() * cards.length)); },
    };
  })();`,
};
