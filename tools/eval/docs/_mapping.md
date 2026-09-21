# 근거 청크 매핑표 (_mapping)

> 카테고리 이름은 `src/types.ts`의 `QueryCategory` 값을 철자 그대로 쓴다.
> id 규칙: `D-D#슬러그`(policy-collection), `D-E#슬러그`(policy-rating), `D-F#슬러그`(glossary-genre).

## 청크-카테고리 매핑

| 청크 id | 제목(##) | 카테고리 |
|---|---|---|
| D-D#데이터-계층 | policy-collection 1. 데이터 계층 | DATA_OPS |
| D-D#재동기화-병합 | policy-collection 2. 재동기화 병합 규칙 | DATA_OPS |
| D-D#저장소-배치 | policy-collection 3. 저장소 배치 | DATA_OPS, HISTORY |
| D-D#스냅샷-로그 | policy-collection 4. 스냅샷 로그 | DATA_OPS |
| D-D#업적-제약 | policy-collection 5. 업적 데이터 수집 제약 | HISTORY, DATA_OPS |
| D-D#수집-범위 | policy-collection 6. 수집 범위 | DATA_OPS |
| D-E#별점-척도 | policy-rating 1. 별점 척도 | SUBJECTIVE |
| D-E#별점-미입력 | policy-rating 2. 별점 미입력의 취급 | SUBJECTIVE |
| D-E#상태-분류 | policy-rating 3. 상태 분류 | SUBJECTIVE |
| D-E#찜-보유-구분 | policy-rating 4. 찜과 보유의 구분 | SUBJECTIVE, HISTORY, DATA_OPS |
| D-E#기피-사유 | policy-rating 5. 기피 사유 표기 | SUBJECTIVE |
| D-E#입력-계층 | policy-rating 6. 입력 계층 | SUBJECTIVE, DATA_OPS |
| D-F#장르-출처 | glossary-genre 1. 장르 태그 출처 | TASTE |
| D-F#플레이타임-분배 | glossary-genre 2. 멀티 장르 플레이타임 분배 | TASTE |
| D-F#정규화 | glossary-genre 3. 정규화 | TASTE |
| D-F#topgenres-주의 | glossary-genre 4. topGenres 주의 | TASTE |
| D-F#기피-상위-겹침 | glossary-genre 5. 기피 집계와 상위 장르의 겹침 | TASTE, SUBJECTIVE |
| D-F#미반영-신호 | glossary-genre 6. 미반영 신호 | TASTE, SUBJECTIVE |

## 데이터 쪽 근거 (다른 워커 소유 — 내용은 보지 않음)

| 문서 | 쓰는 카테고리 |
|---|---|
| D-A library.md | HISTORY |
| D-B games/*.md | HISTORY, SUBJECTIVE |
| D-C taste-profile.json | TASTE |

## 신규 도구-근거 매핑 (도구 재설계 v1)

> 정본은 도구 재설계 계약의 시그니처표다. 아래는 각 신규 도구의 "반환 근거"가 위 청크 id 중 어느 것과 연결되는지만 적은 것이다.
> 카테고리는 5개 그대로이며(명세 상한), 위 청크-카테고리 매핑과 청크 수 집계는 바꾸지 않는다.

| 도구 | 반환 근거 | 연결 청크 id |
|---|---|---|
| `get_achievement_stats` | 업적 달성률 (없으면 결측 표시) | D-D#업적-제약 |
| `get_wishlist` | 찜 목록·개수 | D-E#찜-보유-구분 |
| `find_rating_playtime_gaps` | 플레이타임×별점 교차 상위 | D-E#별점-척도, D-F#미반영-신호 |
| `get_field_coverage` | 해당 필드 결측 현황 | D-D#수집-범위, D-D#업적-제약, D-E#별점-미입력, D-F#장르-출처 |
| `describe_schema` | 어느 데이터가 어느 파일·계층에 있나 | D-D#데이터-계층, D-D#저장소-배치, D-E#입력-계층 |

`get_field_coverage`의 field별 대응: `genre`→D-F#장르-출처, `developers`→D-D#수집-범위, `achievement`→D-D#업적-제약, `rating`→D-E#별점-미입력.

## 카테고리별 연결 청크 수

| 카테고리 | 연결 청크 수 |
|---|---|
| HISTORY | 3 (D-D#저장소-배치, D-D#업적-제약, D-E#찜-보유-구분) + D-A, D-B 사용 |
| TASTE | 6 (D-F 전 청크) + D-C 사용 |
| SUBJECTIVE | 8 (D-E 전 청크 + D-F#미반영-신호, D-F#기피-상위-겹침) + D-B 사용 |
| DATA_OPS | 8 (D-D 전 청크 + D-E#입력-계층, D-E#찜-보유-구분) |
| OUT_OF_SCOPE | 0 |

OUT_OF_SCOPE에 연결된 청크가 하나도 없다. 이는 정상이다 — 범위 밖 문의는 근거를 인용하지 않고 이첩하는 것이 정답이므로 근거가 없다.
