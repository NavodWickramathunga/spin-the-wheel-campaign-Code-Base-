// Scratch card: the customer scratches a foil to reveal the prize the server picked.
module.exports = {
  id: 'scratch-card',
  title: 'Scratch & Win!',
  config: `
    mainTitle: { text: "Scratch &amp; <span class='hl'>Win!</span>", fontSize: "24px" },
    subtitle: { text: "Scratch the card to reveal your reward. Every card is a chance to win.", fontSize: "13.5px" },
    button: { text: "Reveal my prize", busyText: "Getting your card...", style: "ghost" },
    hintText: "Use your finger to scratch the card",
    foilText: "SCRATCH HERE",
    // Share of the foil (%) to scratch off before the card reveals itself.
    revealAtPercent: 45,`,
  css: `
  .scratch { position: relative; width: 100%; aspect-ratio: 16 / 10; padding: 8px; border-radius: 20px; background: #fff;
    box-shadow: 0 14px 34px -10px rgba(17, 24, 39, .35); }
  .scratch-inner { position: relative; width: 100%; height: 100%; overflow: hidden; border-radius: 14px;
    background: repeating-linear-gradient(45deg, var(--surface) 0 10px, #fff 10px 20px); border: 1.5px dashed rgba(var(--brand-rgb), .35); }
  .prize { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 0 12px; }
  .prize[hidden] { display: none; }
  .prize-icon { font-size: 44px; line-height: 1; }
  .prize-name { font-size: 20px; font-weight: 800; line-height: 1.2; color: var(--brand); }
  .prize.lose .prize-name { color: var(--ink-2); }
  .prize-sub { font-size: 12px; font-weight: 600; color: var(--ink-3); }
  #foil { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: grab; transition: opacity .6s ease; }
  #foil.gone { opacity: 0; pointer-events: none; }
  .scratch.waiting #foil { animation: foilPulse 1s ease-in-out infinite; }
  @keyframes foilPulse { 50% { filter: brightness(1.12); } }
  .scratch.done .scratch-inner { animation: popWin .6s cubic-bezier(.3, 1.5, .5, 1); }
  @keyframes popWin { 40% { transform: scale(1.04); } }`,
  html: `
        <div class="scratch" id="scratch">
          <div class="scratch-inner">
            <div class="prize" id="prize" hidden><div class="prize-icon" id="prizeIcon"></div><div class="prize-name" id="prizeName"></div><div class="prize-sub" id="prizeSub"></div></div>
            <canvas id="foil" role="button" tabindex="0" aria-label="Scratch card - scratch or press the button to reveal"></canvas>
          </div>
        </div>`,
  js: `
  const GAME = (function () {
    let c, wrap, foil, g, W = 0, H = 0, data = null, requested = false, revealed = false, drawing = false, last = null, moves = 0;
    const font = 'Inter, -apple-system, "Segoe UI", Roboto, sans-serif';
    function drawFoil() {
      const r = foil.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
      W = r.width; H = r.height;
      foil.width = Math.round(W * dpr); foil.height = Math.round(H * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.globalCompositeOperation = 'source-over';
      const grad = g.createLinearGradient(0, 0, W, H);
      grad.addColorStop(0, '#C3C8D0'); grad.addColorStop(.45, '#F1F3F6'); grad.addColorStop(.55, '#E4E7EC'); grad.addColorStop(1, '#AEB4BE');
      g.fillStyle = grad; g.fillRect(0, 0, W, H);
      g.fillStyle = 'rgba(255, 255, 255, .6)';
      for (let i = 0; i < 160; i++) g.fillRect(Math.random() * W, Math.random() * H, 1.4, 1.4);
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = c.config.brand.primary; g.font = '800 ' + Math.round(H * .13) + 'px ' + font;
      g.fillText(c.config.foilText, W / 2, H / 2 - H * .04);
      g.fillStyle = 'rgba(17, 24, 39, .35)'; g.font = '700 ' + Math.round(H * .08) + 'px ' + font;
      g.fillText('\\u2726  \\u2726  \\u2726', W / 2, H / 2 + H * .14);
    }
    const pos = (e) => { const r = foil.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    function scratchLine(a, b) {
      g.globalCompositeOperation = 'destination-out';
      g.lineWidth = Math.max(28, W * .11); g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    }
    function cleared() {
      const d = g.getImageData(0, 0, foil.width, foil.height).data;
      let n = 0, t = 0;
      for (let i = 3; i < d.length; i += 64) { t++; if (d[i] === 0) n++; }
      return (n / t) * 100;
    }
    function showPrize() {
      const r = c.rewardFor(data);
      c.$('prize').hidden = false;
      c.$('prize').classList.toggle('lose', !data.won);
      c.$('prizeIcon').textContent = c.iconFor(r);
      c.$('prizeName').textContent = data.won ? r.name : 'Better luck next time';
      c.$('prizeSub').textContent = data.won ? 'is yours!' : 'Thanks for playing';
    }
    // The prize is only known (and drawn under the foil) once the server has answered.
    async function start() {
      if (requested) return !!data;
      if (!c.canPlay()) return false;
      requested = true;
      wrap.classList.add('waiting');
      c.setHint('Getting your card ready...');
      const res = await c.play();
      wrap.classList.remove('waiting');
      if (!res) { requested = false; c.setHint(c.config.hintText); return false; }
      data = res;
      showPrize();
      c.setHint('Keep scratching...');
      c.refresh();
      return true;
    }
    function reveal() {
      if (revealed) return;
      revealed = true;
      foil.classList.add('gone');
      wrap.classList.add('done');
      c.setHint('');
      c.buzz(20);
      c.refresh();
      c.wait(900).then(() => c.finish(data));
    }
    function autoScratch() {
      if (revealed) return;
      const t0 = performance.now(), dur = c.reducedMotion ? 1 : 900, rows = 5;
      let prev = null;
      (function step(t) {
        const k = Math.min(1, (t - t0) / dur), row = Math.min(rows - 1, Math.floor(k * rows)), f = (k * rows) % 1;
        const p = { x: (row % 2 ? 1 - f : f) * W, y: ((row + .5) / rows) * H };
        if (prev) scratchLine(prev, p);
        prev = p;
        if (k < 1) requestAnimationFrame(step); else reveal();
      })(t0);
    }
    return {
      init(ctx) {
        c = ctx; wrap = c.$('scratch'); foil = c.$('foil'); g = foil.getContext('2d', { willReadFrequently: true });
        drawFoil();
        if (window.ResizeObserver) new ResizeObserver(() => { if (!data) drawFoil(); }).observe(foil);
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!data) drawFoil(); });
        foil.addEventListener('pointerdown', async (e) => {
          e.preventDefault();
          if (revealed) return;
          try { foil.setPointerCapture(e.pointerId); } catch (x) { /* not supported */ }
          drawing = true; last = pos(e);
          if (!data && !(await start())) drawing = false;
        });
        foil.addEventListener('pointermove', (e) => {
          if (!drawing || !data || revealed) return;
          const p = pos(e);
          scratchLine(last, p); last = p;
          if (++moves % 6 === 0) { c.sfx.tick(); if (cleared() >= c.config.revealAtPercent) reveal(); }
        });
        const stop = () => { drawing = false; if (data && !revealed && cleared() >= c.config.revealAtPercent) reveal(); };
        foil.addEventListener('pointerup', stop);
        foil.addEventListener('pointercancel', stop);
        foil.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); GAME.onButton(); } });
      },
      async onButton() {
        if (!data && !(await start())) return;
        autoScratch();
      },
      buttonActive: () => !!data && !revealed,
    };
  })();`,
};
