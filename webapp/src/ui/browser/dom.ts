/** Helpers de DOM: fallan pronto si el HTML y la UI dejan de coincidir. */

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`La UI no tiene el elemento #${id}`);
  return element as T;
}
