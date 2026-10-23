/** Qué deja elegir el diálogo nativo. */
export type PickKind = 'folder' | 'file' | 'files';

/** Lo que necesita el diálogo para abrirse, ya validado por el controlador. */
export interface PickInput {
  kind: PickKind;
  /** Título de la ventana; acotado a 80 caracteres. */
  title: string;
  /**
   * Extensiones sin punto (`fxb`, `dll`) para el filtro de los diálogos de
   * archivo. Vacío = cualquier archivo. En `folder` no aplica.
   */
  extensions: string[];
  /** Carpeta donde abrir el diálogo, o `null` si no hay una que exista. */
  initialDir: string | null;
}

/** Ya hay un diálogo abierto: dos a la vez no tienen sentido. */
export class PickerBusyError extends Error {
  constructor(message = 'Ya hay un diálogo abierto; ciérralo antes de abrir otro') {
    super(message);
    this.name = 'PickerBusyError';
  }
}

/** El servidor no corre en Windows, así que no hay diálogo nativo. */
export class PickerUnsupportedError extends Error {
  constructor(message = 'El diálogo nativo solo está disponible en Windows') {
    super(message);
    this.name = 'PickerUnsupportedError';
  }
}
