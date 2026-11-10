export function fourCcFromId(id: string | number | undefined): string {
  if (id === undefined || id === '') return '—';
  const num = typeof id === 'number' ? id : Number.parseInt(String(id), 10);
  if (Number.isNaN(num) || num <= 0) return String(id);
  const chars = [
    String.fromCharCode((num >> 24) & 0xff),
    String.fromCharCode((num >> 16) & 0xff),
    String.fromCharCode((num >> 8) & 0xff),
    String.fromCharCode(num & 0xff),
  ].map((c) => (/[\\x20-\\x7e]/.test(c) ? c : '.'));
  return chars.join('');
}

export function bankName(bankPath: string): string {
  return bankPath.split(/[\\\\/]/).at(-1) ?? bankPath;
}
