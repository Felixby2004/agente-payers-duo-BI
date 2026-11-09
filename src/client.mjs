export async function api(path, data) {
  const options = data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  };
  const response = await fetch('/api/' + path, options);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || 'No se pudo completar la operación.');
    error.status = response.status;
    throw error;
  }
  return body;
}

export const localDateInput = (iso = new Date(Date.now() + 3 * 3600000)) =>
  new Date(+new Date(iso) - 5 * 3600000).toISOString().slice(0, 16);
export const fromLima = (input) => new Date(input + ':00-05:00').toISOString();

export function downloadCsv(name, rows) {
  const escape = value => {
    const raw = String(value ?? '');
    return '"' + (/^[=+@\-]/.test(raw) && typeof value !== 'number' ? "'" : '') + raw.replaceAll('"', '""') + '"';
  };
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = name + '.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
