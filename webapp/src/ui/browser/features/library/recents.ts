import { t } from '../../../i18n/index.js';
import { els } from '../../elements.js';
import { appendPaths } from '../../../picker.js';
import { createIcon } from '../../icons.js';
import { bankName } from '../../shared/format/index.js';
import { pathKey } from '../../../recents.js';

export function renderDatalist(list: HTMLDataListElement, values: readonly string[]): void {
  list.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    }),
  );
}

export function renderRecentSelect(
  wrap: HTMLElement,
  select: HTMLSelectElement,
  values: readonly string[],
  current: string,
  placeholder: string,
): void {
  wrap.hidden = values.length === 0;
  select.replaceChildren();
  if (values.length === 0) return;

  const head = document.createElement('option');
  head.value = '';
  head.textContent = placeholder;
  select.append(head);

  for (const value of values) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  }

  select.value = values.includes(current) ? current : '';
}
