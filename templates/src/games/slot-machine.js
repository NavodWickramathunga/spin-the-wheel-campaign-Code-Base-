// Slot machine: 3 reels stop on the prize the server picked (three of a kind = win).
// A losing round never shows three matching symbols.
module.exports = {
  id: 'slot-machine',
  title: 'Spin the Slots!',
  config: `
    mainTitle: { text: "Spin the <span class='hl'>Slots!</span>", fontSize: "24px" },
    subtitle: { text: "Line up three of a kind to win a reward.", fontSize: "13.5px" },
    button: { text: "Pull to spin", busyText: "Spinning...", style: "solid" },
    hintText: "",`,
  css: `
  .slot { --sym: 58px; position: relative; padding: 12px 12px 10px; border-radius: 22px;
    background: linear-gradient(160deg, var(--brand-dark), #24060d); box-shadow: 0 14px 34px -10px rgba(17, 24, 39, .45), inset 0 0 0 2px rgba(255, 255, 255, .08); }
  .slot-top { margin-bottom: 8px; font-size: 11px; font-weight: 800; letter-spacing: 2.4px; color: var(--accent); }
  .lights { display: flex; justify-content: space-between; padding: 0 6px; margin-bottom: 8px; }
  .lights i { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); opacity: .35; }
  .slot.spinning .lights i { animation: blink .5s steps(2) infinite; animation-delay: calc(var(--k) * .07s); }
  .slot.won .lights i { opacity: 1; box-shadow: 0 0 8px var(--accent); }
  @keyframes blink { 50% { opacity: 1; box-shadow: 0 0 8px var(--accent); } }
  .reels { position: relative; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; padding: 6px; border-radius: 14px; background: #12030a; }
  .reel { position: relative; height: calc(var(--sym) * 3); overflow: hidden; border-radius: 10px; background: linear-gradient(#fff, #F3F4F6 50%, #fff); }
  .reel::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(rgba(0, 0, 0, .3), transparent 32%, transparent 68%, rgba(0, 0, 0, .3)); }
  .strip { will-change: transform; }
  .sym { height: var(--sym); display: grid; place-items: center; font-size: 32px; line-height: 1; }
  .reel.spin .strip { animation: loop .32s linear infinite; filter: blur(1.2px); }
  @keyframes loop { from { transform: translateY(0); } to { transform: translateY(calc(var(--sym) * -8)); } }
  .payline { position: absolute; left: 2px; right: 2px; top: 50%; height: var(--sym); transform: translateY(-50%); pointer-events: none;
    border-radius: 10px; border: 2px solid var(--accent); opacity: .85; }
  .slot.won .payline { animation: glow .45s ease-in-out 6 alternate; }
  @keyframes glow { to { box-shadow: 0 0 18px 4px var(--accent); } }
  .slot-result { min-height: 20px; margin-top: 10px; font-size: 14px; font-weight: 800; color: #fff; }
  .slot-result.pop { animation: popIn .45s cubic-bezier(.3, 1.5, .5, 1); }`,
  html: `
        <div class="slot" id="slot">
          <div class="slot-top">&#9733; JACKPOT &#9733;</div>
          <div class="lights" id="lights"></div>
          <div class="reels" id="reels">
            <div class="reel"><div class="strip"></div></div>
            <div class="reel"><div class="strip"></div></div>
            <div class="reel"><div class="strip"></div></div>
            <div class="payline"></div>
          </div>
          <div class="slot-result" id="slotResult"></div>
        </div>`,
  js: `
  const GAME = (function () {
    let c, slot, reels, strips, symbols = ['\\u2B50', '\\uD83D\\uDC8E', '\\uD83C\\uDF81'], spinning = false;
    const pick = () => symbols[Math.floor(Math.random() * symbols.length)];
    const seq = (n) => Array.from({ length: n }, pick);
    const fill = (s, arr) => { s.innerHTML = arr.map((x) => '<div class="sym">' + x + '</div>').join(''); };
    const symH = () => reels[0].getBoundingClientRect().height / 3;
    function idle() {
      strips.forEach((s) => { s.style.transition = 'none'; s.style.transform = 'translateY(0)'; fill(s, seq(3)); });
    }
    // Seamless loop while waiting for the server: 8 symbols, then the first 3 again.
    function loopSeq() { const a = seq(8); return a.concat(a.slice(0, 3)); }
    function losingLine() {
      let line;
      do { line = [pick(), pick(), pick()]; } while (symbols.length > 1 && line[0] === line[1] && line[1] === line[2]);
      return line;
    }
    async function spin() {
      if (spinning || !c.canPlay()) return;
      spinning = true;
      slot.classList.remove('won');
      c.$('slotResult').textContent = '';
      slot.classList.add('spinning');
      reels.forEach((r, i) => { strips[i].style.transition = 'none'; strips[i].style.transform = ''; fill(strips[i], loopSeq()); r.classList.add('spin'); });
      const data = await c.play();
      if (!data) { reels.forEach((r) => r.classList.remove('spin')); slot.classList.remove('spinning'); idle(); spinning = false; return; }
      const r = c.rewardFor(data), icon = c.iconFor(r);
      const line = data.won ? [icon, icon, icon] : losingLine();
      const h = symH(), stopDur = c.reducedMotion ? .2 : 1.1;
      await Promise.all(reels.map((reel, i) => new Promise((done) => setTimeout(() => {
        const s = strips[i];
        reel.classList.remove('spin');
        s.style.transition = 'none'; s.style.transform = 'translateY(0)';
        fill(s, seq(18).concat([pick(), line[i], pick()])); // the middle row ends on line[i]
        void s.offsetHeight;
        s.style.transition = 'transform ' + stopDur + 's cubic-bezier(.15, .85, .25, 1.04)';
        s.style.transform = 'translateY(' + (-18 * h) + 'px)';
        setTimeout(() => { c.sfx.tick(); c.buzz(8); done(); }, stopDur * 1000);
      }, (c.reducedMotion ? 0 : 250) + i * (c.reducedMotion ? 50 : 450)))));
      slot.classList.remove('spinning');
      slot.classList.toggle('won', !!data.won);
      const res = c.$('slotResult');
      res.textContent = data.won ? icon + '  ' + r.name + '!' : 'No match this time';
      res.classList.remove('pop'); void res.offsetWidth; res.classList.add('pop');
      await c.wait(1400);
      c.finish(data);
    }
    return {
      init(ctx) {
        c = ctx; slot = c.$('slot'); reels = [...slot.querySelectorAll('.reel')]; strips = reels.map((r) => r.querySelector('.strip'));
        c.$('lights').innerHTML = Array.from({ length: 12 }, (_, k) => '<i style="--k:' + k + '"></i>').join('');
        idle();
      },
      onRewards(list) {
        const icons = list.map((r) => c.iconFor(r));
        symbols = [...new Set(icons.concat(['\\u2B50', '\\uD83D\\uDC8E']))];
        if (!spinning) idle();
      },
      onButton: spin,
    };
  })();`,
};
