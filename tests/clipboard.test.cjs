'use strict';
const assert = require('node:assert/strict');
const {test} = require('node:test');
const {collectClipboardImages} = require('../web/clipboard.js');

const at = new Date(2026,10,21,10,12,8);
const fake = (files = [],text = '') => ({files,getData:kind => kind === 'text/plain' ? text : ''});
const picture = (type='image/png',body='abc') => new File([body], 'original.name', {type});

test('pastes image bytes into an attachment with a readable filename', async () => {
  const [item] = collectClipboardImages(fake([picture()]),at);
  assert.equal(item.name,'剪贴板-20261121-101208.png');
  assert.equal(item.rel,item.name);
  assert.equal(item.file.type,'image/png');
  assert.equal(await item.file.text(),'abc');
});

test('text paste keeps its normal behavior, even if a clipboard also exposes an image', () => {
  assert.deepEqual(collectClipboardImages(fake([], '设计稿')),[]);
  assert.deepEqual(collectClipboardImages(fake([picture()], '设计稿')),[]);
  assert.deepEqual(collectClipboardImages(null),[]);
});

test('unknown, active markup, and empty files are not accepted as pasted images', () => {
  assert.deepEqual(collectClipboardImages(fake([
    picture('image/svg+xml'),picture('text/html'),picture('image/png',''),picture('application/octet-stream')
  ]),at),[]);
});

test('multiple supported images preserve order and get distinct file names', () => {
  const items = collectClipboardImages(fake([picture('image/jpeg'),picture('image/webp')]),at);
  assert.deepEqual(items.map(x => x.name),['剪贴板-20261121-101208-1.jpg','剪贴板-20261121-101208-2.webp']);
});
