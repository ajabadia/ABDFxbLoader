export function readStorage(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    // localStorage puede estar bloqueado; la UI sigue funcionando.
    return '';
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* localStorage puede estar bloqueado; la UI sigue funcionando. */
  }
}
