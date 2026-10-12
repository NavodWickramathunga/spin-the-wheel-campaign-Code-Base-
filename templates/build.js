// Builds the self-contained CleverTap game templates: shell (src/shell.html) + one game (src/games/*.js).
//   node templates/build.js
// Output: templates/<game>.html (paste into CleverTap) and public/game-<game>.html (browser preview / Template Studio).
// Also copies the wheel templates (clevertap-custom-html*.html) to public/wheel-*.html for the Studio.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'src');
const shell = fs.readFileSync(path.join(SRC, 'shell.html'), 'utf8');
const PUBLIC = path.join(__dirname, '..', 'public');

for (const file of fs.readdirSync(path.join(SRC, 'games')).filter((f) => f.endsWith('.js'))) {
  const game = require(path.join(SRC, 'games', file));
  const out = shell
    .replace('__GAME_ID__', game.id)
    .replace('__TITLE__', game.title.replace(/&/g, '&amp;'))
    .replace('__GAME_CONFIG__', game.config.replace(/^\n/, ''))
    .replace('__GAME_CSS__', game.css.replace(/^\n/, ''))
    .replace('__GAME_HTML__', game.html.replace(/^\n/, ''))
    .replace('__GAME_JS__', game.js.replace(/^\n/, ''));
  if (/__GAME_[A-Z]+__|__TITLE__/.test(out)) throw new Error(`${file}: unreplaced placeholder`);
  // Every inline script must parse.
  [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) => {
    try { new Function(m[1]); } catch (e) { throw new Error(`${file}: script ${i}: ${e.message}`); }
  });
  fs.writeFileSync(path.join(__dirname, game.id + '.html'), out);
  fs.writeFileSync(path.join(PUBLIC, 'game-' + game.id + '.html'), out);
  console.log('built', game.id + '.html', `(${Math.round(out.length / 1024)} KB)`);
}

const ROOT = path.join(__dirname, '..');
for (const file of fs.readdirSync(ROOT).filter((f) => /^clevertap-custom-html(-[\w-]+)?\.html$/.test(f))) {
  const style = (file.match(/^clevertap-custom-html-?([\w-]*)\.html$/)[1]) || 'classic';
  fs.copyFileSync(path.join(ROOT, file), path.join(PUBLIC, `wheel-${style}.html`));
  console.log('copied', file, '-> public/wheel-' + style + '.html');
}
