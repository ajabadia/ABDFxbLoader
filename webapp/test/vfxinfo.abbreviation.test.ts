import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveNameAbbreviation } from '../src/library/vfxinfo';
import { parseWizardText, serializeWizardToVfxinfo } from '../src/wizard/wizard-parser';

test('la abreviatura toma el 4CC big-endian del id cuando es imprimible', () => {
  // `FUN_00450d70` de la v2 del host: NAS2 = 0x4E415332.
  assert.equal(deriveNameAbbreviation(1312903986, 'NeuronVS'), 'NAS2');
  assert.equal(deriveNameAbbreviation(1130447212, 'Alchemy'), 'CaAl');
  assert.equal(deriveNameAbbreviation(1668047986, 'cleardrum'), 'cldr');
});

test('cae a los cuatro primeros caracteres del nombre si el id no es ASCII', () => {
  // SampleTank 2 SE: 0x000F218D, el primer byte no es imprimible.
  assert.equal(deriveNameAbbreviation(991629, 'SampleTank2 SE'), 'Samp');
});

test('la abreviatura explícita del wizard manda y las flags sobreviven al serializar', () => {
  const record = parseWizardText(
    [
      'id: 1731679536',
      'name: Albino3',
      'name_abbreviation: ALBO',
      'dll_name: Albino3/Albino3.dll',
      'no_vst_chunks: 1',
      'dont_free_library_in_vfx_application: 1',
    ].join('\r\n'),
  );

  assert.equal(record.nameAbbreviation, 'ALBO');

  const out = serializeWizardToVfxinfo(record);
  assert.match(out, /^name_abbreviation: ALBO\r$/m);
  assert.match(out, /^no_vst_chunks: 1\r$/m);
  assert.match(out, /^dont_free_library_in_vfx_application: 1\r$/m);
});
