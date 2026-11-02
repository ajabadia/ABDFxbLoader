import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { inlineScriptHashes } from '../src/app.setup';

/**
 * La CSP firma el import map en línea con su hash SHA-256. El navegador hashea
 * el texto del script **después** de normalizar los saltos de línea del HTML
 * (CRLF y CR pasan a LF), así que hashear los bytes del fichero da un valor
 * distinto en cuanto el fichero está en CRLF —y entonces el navegador bloquea
 * el import map y la app no arranca—.
 */
test('el hash se calcula sobre el texto normalizado a LF', () => {
  const html = '<script type="importmap">\r\n{"imports":{}}\r\n</script>';
  const expected = createHash('sha256').update('\n{"imports":{}}\n', 'utf8').digest('base64');
  assert.deepEqual(inlineScriptHashes(html), [`'sha256-${expected}'`]);
});

test('ignora los scripts con `src` y los vacíos', () => {
  assert.deepEqual(inlineScriptHashes('<script src="/app.js"></script><script></script>'), []);
});
