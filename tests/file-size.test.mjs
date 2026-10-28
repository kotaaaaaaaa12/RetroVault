import test from 'node:test';
import assert from 'node:assert/strict';
import { formatFileSize } from '../assets/js/file-size.js';

test('small uploaded files display a meaningful size instead of rounding to zero MiB', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(1), '1 B');
  assert.equal(formatFileSize(1023), '1023 B');
  assert.equal(formatFileSize(40976), '40.0 KiB');
  assert.equal(formatFileSize(1024), '1.0 KiB');
  assert.equal(formatFileSize(1024 ** 2), '1.0 MiB');
  assert.equal(formatFileSize(8 * 1024 ** 3), '8.0 GiB');
  assert.equal(formatFileSize(undefined), '—');
});
