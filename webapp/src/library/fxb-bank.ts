/**
 * Formato VST2 de banco de presets (`.fxb`, chunk `FxBk`) y de banco opaco
 * (`FBCh`), tal como lo valida `fxHeader::check()` en `fxbLoader.dll`
 * (`FUN_100038c0`): chunkMagic, byteSize, fxMagic, versión, uniqueID y versión
 * del plugin.
 *
 * Los enteros se escriben en el orden de bytes del host que creó el archivo.
 * El binario original decide si hay que intercambiarlos con un flag global; aquí
 * se detecta por el propio `chunkMagic` y se aceptan ambos órdenes.
 */

/** `CCONST('C','c','n','K')`. */
const CHUNK_MAGIC = 0x43636e4b;
/** `CCONST('F','x','B','k')`. */
const FX_BANK_MAGIC = 0x4678426b;
/** `CCONST('F','B','C','h')`. */
const FX_CHUNK_BANK_MAGIC = 0x46424368;
/** `CCONST('F','x','C','k')`, programa con parámetros sueltos. */
const FX_PROGRAM_MAGIC = 0x4678436b;
/** `CCONST('F','P','C','h')`, programa con chunk opaco. */
const FX_CHUNK_PROGRAM_MAGIC = 0x46504368;

/** chunkMagic + byteSize + 148 bytes de cabecera del banco. */
export const FXB_HEADER_SIZE = 156;
/** Cabecera + el `size` que precede al chunk opaco de un `FBCh`. */
export const FXB_CHUNK_HEADER_SIZE = 160;
/** fxProgram sin chunkMagic ni byteSize: 6 campos + nombre de 28 bytes. */
const PROGRAM_MIN_PAYLOAD = 48;

/** Límite defensivo: un banco de parámetros no debería acercarse. */
export const FXB_MAX_BYTES = 64 * 1024 * 1024;
/** Tope de programas para no recorrer archivos absurdos. */
const FXB_MAX_PROGRAMS = 65536;

export type FxbEndianness = 'little' | 'big';
export type FxbBankKind = 'FxBk' | 'FBCh';
export type BankCompatibility = 'compatible' | 'incompatible' | 'unverified';

export interface FxbBankInfo {
  kind: FxbBankKind;
  endianness: FxbEndianness;
  /** `byteSize` de la cabecera (excluye los 8 primeros bytes). */
  byteSize: number;
  version: number;
  /** Representación legible del uniqueID de 4 caracteres, o `0x…`. */
  uniqueId: string;
  /** Valor canónico `CCONST(a,b,c,d)` del uniqueID. */
  uniqueIdValue: number;
  fxVersion: number;
  /** Programas del banco (`FxBk`); en `FBCh` es informativo. */
  numPrograms: number;
  /** Solo en la versión 2 del formato de banco. */
  currentProgram: number | null;
  /** Tamaño del chunk opaco (`FBCh`). */
  chunkSize: number | null;
}

export interface FxbBankParse {
  /** `null` solo si ni siquiera se pudo interpretar la cabecera. */
  bank: FxbBankInfo | null;
  /** Defectos que impiden usar el banco. */
  issues: string[];
  /** Rarezas que no impiden la importación. */
  warnings: string[];
}

function readU32(data: Buffer, offset: number, endianness: FxbEndianness): number {
  return endianness === 'little' ? data.readUInt32LE(offset) : data.readUInt32BE(offset);
}

/** `CCONST('M','y','S','y')` → `0x4d795379`. */
export function uniqueIdFromText(text: string): number {
  if (text.length !== 4) {
    throw new RangeError('expectedUniqueId debe tener exactamente 4 caracteres (o ser un entero)');
  }
  const codes = [...text].map((character) => character.codePointAt(0) ?? 0);
  if (codes.some((code) => code > 0xff)) {
    throw new RangeError('expectedUniqueId contiene caracteres fuera de un byte');
  }
  return (
    (((codes[0] ?? 0) << 24) |
      ((codes[1] ?? 0) << 16) |
      ((codes[2] ?? 0) << 8) |
      (codes[3] ?? 0)) >>>
    0
  );
}

/** `0x4d795379` → `MySy`; si no es imprimible, `0x4d795379`. */
export function uniqueIdToText(value: number): string {
  const bytes = [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
  if (bytes.every((byte) => byte >= 0x20 && byte <= 0x7e)) {
    return String.fromCharCode(...bytes);
  }
  return `0x${(value >>> 0).toString(16).padStart(8, '0')}`;
}

export function parseUniqueIdInput(input: string | number): number {
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0 || input > 0xffffffff) {
      throw new RangeError('expectedUniqueId numérico debe ser un entero entre 0 y 0xFFFFFFFF');
    }
    return input >>> 0;
  }
  return uniqueIdFromText(input);
}

/**
 * Parsea y valida un `.fxb`. `totalSize` permite validar solo la cabecera
 * (pasando un buffer de 156 bytes y el tamaño real del archivo).
 */
export function parseFxbBank(data: Buffer, totalSize: number = data.length): FxbBankParse {
  const issues: string[] = [];
  const warnings: string[] = [];
  const fail = (issue: string): FxbBankParse => ({
    bank: null,
    issues: [...issues, issue],
    warnings,
  });

  if (totalSize < FXB_HEADER_SIZE) {
    return fail(`archivo de ${totalSize} bytes; un .fxb necesita al menos ${FXB_HEADER_SIZE}`);
  }
  if (data.length < FXB_HEADER_SIZE) {
    return fail(`no se pudieron leer los ${FXB_HEADER_SIZE} bytes de cabecera`);
  }

  let endianness: FxbEndianness | null = null;
  if (readU32(data, 0, 'little') === CHUNK_MAGIC) endianness = 'little';
  else if (readU32(data, 0, 'big') === CHUNK_MAGIC) endianness = 'big';
  if (endianness === null) {
    return fail('chunkMagic distinto de "CcnK": no parece un banco VST2');
  }

  const byteSize = readU32(data, 4, endianness);
  const fxMagic = readU32(data, 8, endianness);
  const version = readU32(data, 12, endianness);
  const uniqueIdValue = readU32(data, 16, endianness);
  const fxVersion = readU32(data, 20, endianness);
  const count = readU32(data, 24, endianness);

  if (byteSize !== totalSize - 8) {
    issues.push(
      `byteSize ${byteSize} no coincide con el tamaño del archivo (${totalSize - 8} sin cabecera de chunk)`,
    );
  }
  if (version !== 1 && version !== 2) {
    issues.push(`versión de banco ${version}; el formato conocido usa 1 o 2`);
  }
  const currentProgram = version === 2 ? readU32(data, 28, endianness) : null;

  let kind: FxbBankKind;
  if (fxMagic === FX_BANK_MAGIC) kind = 'FxBk';
  else if (fxMagic === FX_CHUNK_BANK_MAGIC) kind = 'FBCh';
  else {
    return fail(`fxMagic 0x${fxMagic.toString(16)} no es "FxBk" ni "FBCh"`);
  }

  let chunkSize: number | null = null;
  let numPrograms = count;

  if (kind === 'FBCh') {
    if (totalSize < FXB_CHUNK_HEADER_SIZE) {
      issues.push(
        `un FBCh necesita al menos ${FXB_CHUNK_HEADER_SIZE} bytes (cabecera + tamaño del chunk)`,
      );
    } else if (data.length < FXB_CHUNK_HEADER_SIZE) {
      issues.push('no se pudo leer el tamaño del chunk del banco');
    } else {
      chunkSize = readU32(data, FXB_HEADER_SIZE, endianness);
      const expectedTotal = FXB_CHUNK_HEADER_SIZE + chunkSize;
      if (totalSize !== expectedTotal) {
        issues.push(
          `el banco declara un chunk de ${chunkSize} bytes pero el archivo tiene ` +
            `${totalSize - FXB_CHUNK_HEADER_SIZE}`,
        );
      }
    }
  } else if (count > FXB_MAX_PROGRAMS) {
    issues.push(`numPrograms ${count} supera el máximo razonable (${FXB_MAX_PROGRAMS})`);
  } else if (data.length >= totalSize) {
    let offset = FXB_HEADER_SIZE;
    let seen = 0;
    for (let index = 0; index < count; index += 1) {
      if (offset + 8 > totalSize) {
        issues.push(`programa ${index + 1}: el archivo termina antes de su cabecera`);
        break;
      }
      const programMagic = readU32(data, offset, endianness);
      const programSize = readU32(data, offset + 4, endianness);
      if (programMagic !== CHUNK_MAGIC) {
        issues.push(`programa ${index + 1}: chunkMagic distinto de "CcnK"`);
        break;
      }
      if (programSize < PROGRAM_MIN_PAYLOAD || offset + 8 + programSize > totalSize) {
        issues.push(
          `programa ${index + 1}: byteSize ${programSize} fuera de rango ` +
            `(quedan ${totalSize - offset - 8} bytes)`,
        );
        break;
      }

      const programFxMagic = readU32(data, offset + 8, endianness);
      const programVersion = readU32(data, offset + 12, endianness);
      const programUniqueId = readU32(data, offset + 16, endianness);
      const programFxVersion = readU32(data, offset + 20, endianness);
      const numParams = readU32(data, offset + 24, endianness);

      if (programVersion !== 1) {
        warnings.push(`programa ${index + 1}: versión ${programVersion}, se esperaba 1`);
      }
      if (programUniqueId !== uniqueIdValue) {
        warnings.push(
          `programa ${index + 1}: uniqueID ${uniqueIdToText(programUniqueId)} distinto del banco`,
        );
      }
      if (programFxVersion !== fxVersion) {
        warnings.push(
          `programa ${index + 1}: versión del plugin ${programFxVersion} distinta del banco`,
        );
      }

      if (programFxMagic === FX_PROGRAM_MAGIC) {
        const expected = PROGRAM_MIN_PAYLOAD + 4 * numParams;
        if (programSize !== expected) {
          issues.push(
            `programa ${index + 1}: byteSize ${programSize} distinto de ${expected} ` +
              `(${numParams} parámetros)`,
          );
        }
      } else if (programFxMagic === FX_CHUNK_PROGRAM_MAGIC) {
        const declaredChunk = readU32(data, offset + 8 + PROGRAM_MIN_PAYLOAD, endianness);
        if (programSize !== 52 + declaredChunk) {
          issues.push(
            `programa ${index + 1}: byteSize ${programSize} distinto de ${52 + declaredChunk} ` +
              `(chunk de ${declaredChunk} bytes)`,
          );
        }
      } else {
        issues.push(
          `programa ${index + 1}: fxMagic 0x${programFxMagic.toString(16)} no es "FxCk" ni "FPCh"`,
        );
      }

      offset += 8 + programSize;
      seen += 1;
    }

    if (issues.length === 0 && offset !== totalSize) {
      issues.push(
        `sobran ${totalSize - offset} bytes tras los ${seen} programas declarados`,
      );
    }
    numPrograms = count;
  }

  return {
    bank: {
      kind,
      endianness,
      byteSize,
      version,
      uniqueId: uniqueIdToText(uniqueIdValue),
      uniqueIdValue,
      fxVersion,
      numPrograms,
      currentProgram,
      chunkSize,
    },
    issues,
    warnings,
  };
}

export interface FxbConversion {
  /** Copia convertida; si el origen ya estaba en ese orden, idéntica al original. */
  data: Buffer;
  /** Campos de 32 bits cuyo orden de bytes se invirtió (enteros y floats). */
  fields: number;
  /** Programas recorridos de un `FxBk`; 0 en un `FBCh`. */
  programs: number;
  /** Tamaños de chunk reescritos: uno por programa `FPCh`, más el del `FBCh`. */
  chunks: number;
}

/**
 * Reescribe un banco en el orden de bytes pedido, como el host que guarda el
 * struct nativo sin convertirlo. Solo invierte los campos numéricos: el nombre
 * de cada programa y los chunks opacos quedan byte a byte iguales.
 *
 * No valida el archivo (para eso está `parseFxbBank`), pero sí rechaza lo que no
 * puede convertir sin corromperlo: magic desconocido, programas truncados o
 * parámetros que se salen de su programa. Si el banco ya está en el orden
 * pedido devuelve una copia sin tocar y `fields: 0`.
 */
export function convertFxbEndianness(data: Buffer, target: FxbEndianness): FxbConversion {
  if (target !== 'big' && target !== 'little') {
    throw new RangeError('el orden de bytes de destino debe ser "big" o "little"');
  }
  if (data.length < FXB_HEADER_SIZE) {
    throw new Error(`archivo de ${data.length} bytes; un .fxb necesita al menos ${FXB_HEADER_SIZE}`);
  }

  let source: FxbEndianness | null = null;
  if (readU32(data, 0, 'little') === CHUNK_MAGIC) source = 'little';
  else if (readU32(data, 0, 'big') === CHUNK_MAGIC) source = 'big';
  if (source === null) {
    throw new Error('chunkMagic distinto de "CcnK": no parece un banco VST2');
  }

  const fxMagic = readU32(data, 8, source);
  if (fxMagic !== FX_BANK_MAGIC && fxMagic !== FX_CHUNK_BANK_MAGIC) {
    throw new Error(`fxMagic 0x${fxMagic.toString(16)} no es "FxBk" ni "FBCh"`);
  }

  const converted = Buffer.from(data);
  if (source === target) {
    return {
      data: converted,
      fields: 0,
      programs: fxMagic === FX_BANK_MAGIC ? readU32(data, 24, source) : 0,
      chunks: 0,
    };
  }

  /** Invierte los 4 bytes del campo; vale para enteros y para floats. */
  const swap = (offset: number): void => {
    const first = converted[offset]!;
    const second = converted[offset + 1]!;
    const third = converted[offset + 2]!;
    const fourth = converted[offset + 3]!;
    converted[offset] = fourth;
    converted[offset + 1] = third;
    converted[offset + 2] = second;
    converted[offset + 3] = first;
  };

  let fields = 0;
  let programs = 0;
  let chunks = 0;

  // Cabecera del banco: chunkMagic, byteSize, fxMagic, version, fxID,
  // fxVersion, numPrograms y currentProgram/future.
  for (let offset = 0; offset < 32; offset += 4) {
    swap(offset);
    fields += 1;
  }

  if (fxMagic === FX_CHUNK_BANK_MAGIC) {
    if (data.length < FXB_CHUNK_HEADER_SIZE) {
      throw new Error(`un FBCh necesita al menos ${FXB_CHUNK_HEADER_SIZE} bytes`);
    }
    swap(FXB_HEADER_SIZE);
    fields += 1;
    chunks += 1;
    return { data: converted, fields, programs, chunks };
  }

  const count = readU32(data, 24, source);
  let offset = FXB_HEADER_SIZE;
  for (let index = 0; index < count; index += 1) {
    if (offset + 8 > data.length) {
      throw new Error(`programa ${index + 1}: el archivo termina antes de su cabecera`);
    }
    const programSize = readU32(data, offset + 4, source);
    const programMagic = readU32(data, offset + 8, source);
    if (programMagic !== FX_PROGRAM_MAGIC && programMagic !== FX_CHUNK_PROGRAM_MAGIC) {
      throw new Error(
        `programa ${index + 1}: fxMagic 0x${programMagic.toString(16)} no es "FxCk" ni "FPCh"`,
      );
    }
    if (offset + 8 + programSize > data.length) {
      throw new Error(`programa ${index + 1}: byteSize ${programSize} se sale del archivo`);
    }

    // 7 campos del programa: chunkMagic, byteSize, fxMagic, version, fxID,
    // fxVersion y numParams. El nombre de 28 bytes no es numérico.
    for (let field = 0; field < 7; field += 1) {
      swap(offset + 4 * field);
      fields += 1;
    }

    if (programMagic === FX_PROGRAM_MAGIC) {
      const numParams = readU32(data, offset + 24, source);
      if (56 + 4 * numParams > 8 + programSize) {
        throw new Error(
          `programa ${index + 1}: ${numParams} parámetros no caben en ${programSize} bytes`,
        );
      }
      for (let param = 0; param < numParams; param += 1) {
        swap(offset + 56 + 4 * param);
        fields += 1;
      }
    } else {
      // Chunk opaco: solo se invierte el int32 que declara su tamaño.
      swap(offset + 56);
      fields += 1;
      chunks += 1;
    }

    offset += 8 + programSize;
    programs += 1;
  }

  return { data: converted, fields, programs, chunks };
}

export interface BankReference {
  source: 'explicit' | 'existing-bank' | 'batch' | 'none';
  uniqueId: string | null;
  uniqueIdValue: number | null;
  fxVersion: number | null;
  /** Archivo del que salió la referencia, si aplica. */
  file: string | null;
}

export interface BankCompatibilityCheck {
  compatibility: BankCompatibility;
  reason?: string;
}

/**
 * `FUN_100038c0` (descompilado) solo compara: chunkMagic, que `fxMagic` sea uno
 * de los cuatro válidos y el `fxID` contra el uniqueID del plugin. No mira
 * `byteSize`, la versión del banco ni `fxVersion`. Por eso la compatibilidad se
 * decide solo por uniqueID; `expectedFxVersion` se respeta únicamente si el
 * cliente lo pide explícitamente.
 */
export function checkBankCompatibility(
  bank: FxbBankInfo,
  reference: BankReference,
): BankCompatibilityCheck {
  if (reference.uniqueIdValue === null && reference.fxVersion === null) {
    return { compatibility: 'unverified' };
  }

  const problems: string[] = [];
  if (reference.uniqueIdValue !== null && bank.uniqueIdValue !== reference.uniqueIdValue) {
    problems.push(
      `uniqueID ${bank.uniqueId} (0x${bank.uniqueIdValue.toString(16)}) distinto del esperado ` +
        `${reference.uniqueId ?? `0x${reference.uniqueIdValue.toString(16)}`}`,
    );
  }
  if (
    reference.source === 'explicit' &&
    reference.fxVersion !== null &&
    bank.fxVersion !== reference.fxVersion
  ) {
    problems.push(
      `versión del plugin ${bank.fxVersion} distinta de la esperada ${reference.fxVersion}`,
    );
  }

  if (problems.length > 0) {
    return { compatibility: 'incompatible', reason: problems.join('; ') };
  }
  return { compatibility: 'compatible' };
}
