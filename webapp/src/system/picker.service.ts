import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { PickerBusyError, PickerUnsupportedError } from './picker.types';
import type { PickInput } from './picker.types';

/**
 * Diálogos nativos para la vista: `Elegir…` junto a la carpeta de la librería,
 * el DLL del cargador y la lista de `.fxb` a importar.
 *
 * El navegador no puede dar rutas absolutas (`<input type="file">` solo expone
 * el nombre), así que el diálogo lo abre el servidor, que corre en la misma
 * máquina. Se usa PowerShell con `System.Windows.Forms`: es lo que Windows ya
 * trae, sin dependencias nativas que compilar. Cada ruta se devuelve en base64
 * por stdout para que los acentos y los espacios no dependan de la página de
 * códigos de la consola.
 *
 * Cancelar no es un error: devuelve una lista vacía. Un segundo diálogo
 * mientras hay uno abierto es un 409 (`PickerBusyError`), y fuera de Windows es
 * un 501 (`PickerUnsupportedError`).
 */

/** Abre el diálogo y devuelve las rutas elegidas (vacío si se cancela). */
export type PickerRunner = (input: PickInput) => Promise<string[]>;

/**
 * PowerShell que muestra el diálogo. Los datos viajan por variables de entorno,
 * no interpolados en el script: un título con comillas no puede cambiar el
 * comando.
 */
const PICKER_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  '$kind = $env:FXB_PICK_KIND',
  '$title = $env:FXB_PICK_TITLE',
  '$initial = $env:FXB_PICK_INITIAL',
  "if ($kind -eq 'folder') {",
  '  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
  '  $dialog.Description = $title',
  '  $dialog.UseDescriptionForTitle = $true',
  "  if ($initial -ne '') { $dialog.SelectedPath = $initial }",
  '  if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }',
  '  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath)))',
  '  exit 0',
  '}',
  '$dialog = New-Object System.Windows.Forms.OpenFileDialog',
  '$dialog.Title = $title',
  '$dialog.CheckFileExists = $true',
  "$dialog.Multiselect = ($kind -eq 'files')",
  '$extensions = $env:FXB_PICK_EXT',
  "if ($extensions -ne '') {",
  "  $patterns = ($extensions.Split(';') | ForEach-Object { \"*.$_\" }) -join ';'",
  '  $dialog.Filter = "Archivos ($patterns)|$patterns|Todos los archivos (*.*)|*.*"',
  '}',
  "if ($initial -ne '') { $dialog.InitialDirectory = $initial }",
  'if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 0 }',
  "$paths = if ($kind -eq 'files') { $dialog.FileNames } else { @($dialog.FileName) }",
  'foreach ($path in $paths) {',
  '  [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($path)))',
  '}',
].join('\n');

/** Decodifica la salida del script: una ruta en base64 por línea. */
export function parsePickerOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => Buffer.from(line, 'base64').toString('utf8'))
    .filter((value) => value !== '');
}

/** Ejecuta el diálogo con PowerShell; es el runner real del servicio. */
export function runPowerShellPicker(input: PickInput): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-Command', PICKER_SCRIPT], {
      env: {
        ...process.env,
        FXB_PICK_KIND: input.kind,
        FXB_PICK_TITLE: input.title,
        FXB_PICK_EXT: input.extensions.join(';'),
        FXB_PICK_INITIAL: input.initialDir ?? '',
      },
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    child.on('error', (error) => {
      reject(new Error(`no se pudo abrir el diálogo: ${error.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() === ''
              ? `el diálogo terminó con ${String(code)}`
              : `el diálogo terminó con ${String(code)}: ${stderr.trim()}`,
          ),
        );
        return;
      }
      resolve(parsePickerOutput(stdout));
    });
  });
}

/** `true` solo para una carpeta que existe: el diálogo no acepta otra cosa. */
function existingDirectory(target: string | null): string | null {
  if (target === null) return null;
  try {
    return statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

export class PickerService {
  private busy = false;

  /**
   * `platform` y `runner` se pueden fijar en los tests; en la app se usa el
   * sistema real. El módulo lo construye con una factory, así que Nest no
   * interpreta estos parámetros como dependencias.
   */
  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly runner: PickerRunner = runPowerShellPicker,
  ) {}

  async pick(input: PickInput): Promise<string[]> {
    if (this.platform !== 'win32') throw new PickerUnsupportedError();
    if (this.busy) throw new PickerBusyError();

    this.busy = true;
    try {
      return await this.runner({
        ...input,
        // Un `initialDir` que ya no existe haría fallar al diálogo; se descarta.
        initialDir: existingDirectory(input.initialDir),
      });
    } finally {
      this.busy = false;
    }
  }
}
