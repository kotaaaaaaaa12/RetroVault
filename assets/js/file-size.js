export function formatFileSize(size) {
  if (!Number.isFinite(size) || size < 0) return '—';
  if (size < 1024) return size + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)) - 1, units.length - 1);
  return (size / 1024 ** (index + 1)).toFixed(1) + ' ' + units[index];
}
