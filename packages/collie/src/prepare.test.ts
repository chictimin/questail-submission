/**
 * prepare title_ko 결정 pure tests (LLM 추출 호출 없음).
 *
 * 실행: `tsc -p packages/collie` 후 `node --test packages/collie/dist/prepare.test.js`
 * 규칙: raw.ko.name이 en과 다를 때만 title_ko (코퍼스 실측 29건).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectTitleKo } from './prepare.js';

describe('selectTitleKo', () => {
  it('ko가 en과 다를 때만 싣는다', () => {
    assert.equal(selectTitleKo('Subnautica', '서브노티카'), '서브노티카');
    assert.equal(selectTitleKo('Palworld', 'Palworld / 팰월드'), 'Palworld / 팰월드');
    assert.equal(selectTitleKo("Baldur's Gate 3", '발더스 게이트 3'), '발더스 게이트 3');
  });

  it('같거나 비어 있으면 싣지 않는다', () => {
    assert.equal(selectTitleKo('Hades', 'Hades'), undefined);
    assert.equal(selectTitleKo('Hades', ''), undefined);
    assert.equal(selectTitleKo('', '하데스'), undefined);
    assert.equal(selectTitleKo(undefined, '하데스'), undefined);
    assert.equal(selectTitleKo('Hades', undefined), undefined);
  });

  it('공백 차이도 다르면 싣는다 (exact 비교)', () => {
    assert.equal(selectTitleKo('Frostpunk 2', '프로스트펑크2'), '프로스트펑크2');
  });
});
