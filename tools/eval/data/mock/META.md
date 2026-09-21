# Mock Data META

> **고지: 이 디렉토리(data/mock)의 모든 값은 합성 목데이터이며 실제 사용자 데이터가 아니다.**
> 게임명·appid·장르만 실제 Steam 공개 정보를 차용했고,
> 플레이타임·별점·상태·기피사유·한줄평·일시 등 나머지 모든 값은
> seed 고정 난수로 생성한 합성값이다. 실데이터는 스키마·분포 참고용으로만 읽었고,
> 저장소에 복사하지 않았다.

- 생성 시각: 2026-09-17T03:20:35.040Z
- seed: 20260917 (코드 상수 — 변경 시 전체 산출물이 달라진다)
- 데이터 고정 시각(generated_at): 1786924800000 (2026-08-17T00:00:00.000Z)
  - 재현성을 위해 Date.now() 대신 상수를 쓴다. 몇 번을 돌려도 바이트 동일 결과가 나온다.
  - 단위 주의: generated_at 은 밀리초(Date.now 계열, core dist/storage/library.js writeLibraryIndex),
    last_played 는 초(Steam rtime_last_played 를 그대로 담음, core dist/normalize/index.js).
    두 필드의 단위가 다르며 의도된 설계다. 헷갈려도 generated_at 을 초로 바꾸지 마라.
- 보유 게임: 120건 / 위시리스트: 51건 / 노트 파일: 171개
- 형식: @questail/core 의 renderLibraryMarkdown / serializeGameNote + formatFrontmatter
  출력과 바이트 동일 형식을 재현했다 (core import 없이 재구현).
  생성 직후 설치된 core 의 parseLibraryMarkdown / parseGameNote 로 왕복 검증한다.
- 실행: `node scripts/gen-mock.mjs` (외부 의존성 없음, node 내장 모듈만 사용)

## 플레이타임 분포 (보유 120건, 단위: 분)

| 지표 | 실제 산출 | 목표 | 오차 |
| --- | --- | --- | --- |
| min | 0 | - | - |
| Q1 | 165.8 | 163 | 1.7% |
| 중앙값 | 1162.5 | 1170 | -0.6% |
| Q3 | 3805.0 | 3837 | -0.8% |
| max | 20855 | - | - |
| 상위 20개 점유율 | 66.8% | 66.8% | -0.0% |

- 합성 방법: 목표 사분위수를 지나는 단조 기준 곡선에서 순위별 값을 취한 뒤,
  하위 3건을 0분(미플레이)으로 두고 상위 20건을 스케일해 점유율을 맞췄다.
  게임 배정은 대표 장르가 고몰입군(RPG/Strategy/Simulation/Massively Multiplayer)인
  게임에 상위 플레이타임을 우선 배정했다. lastPlayedAt 은 고정 시각 기준
  과거 3년 범위에서 플레이타임과 무관한 합성 분포로 찍었다(상세 무작위).
- taste-profile.json 의 playtimeDistribution 은 위 5수 요약과 같은 값이다.

## 장르 가중치 (태그 발생 점유율)

| 장르 | 실제 산출 | 목표 | 오차 |
| --- | --- | --- | --- |
| Action | 0.212 | 0.217 | -2.2% |
| Adventure | 0.190 | 0.189 | 0.8% |
| RPG | 0.165 | 0.182 | -9.6% |
| Indie | 0.177 | 0.160 | 10.9% |
| Strategy | 0.091 | 0.093 | -2.2% |
| Simulation | 0.069 | 0.060 | 15.4% |
| Casual | 0.048 | 0.050 | -4.8% |
| Massively Multiplayer | 0.017 | 0.022 | -21.3% |
| Racing | 0.013 | 0.015 | -13.4% |
| Sports | 0.017 | 0.012 | 44.3% |

- 가중치 정의: 장르 태그 1개 = 1표로 센 발생 점유율 (장르 누락 4건은 0표).
  총 태그 수: 231.
- taste-profile.json 의 topGenres 는 위와 같은 계산값이다 (손 상수 없음).

## 위시리스트

- 51건, 보유 120건과 교집합 0건 (생성 시 assert로 확인).
- 위시 노트는 source manual + wishlisted true + status wishlist 로 기록했고,
  library.md(보유 정본)에는 포함하지 않았다. appid 목록은 taste-profile.json 의
  wishlistAppIds 를 따른다.

## 의도적 함정 4개 (평가셋 근거)

1. 장르 비어 있음 (메타 누락, 노트에 genres 키 자체가 없음) — 4건:
   - game_id 1706830 (Muck)
   - game_id 1782210 (Crab Game)
   - game_id 223850 (3DMark)
   - game_id 431960 (Wallpaper Engine)
2. achievementPct 전 게임 null — library.md 의 achievement_pct 열 전체가 비어 있고,
   전 게임 노트에 achievement_pct 키가 없다. 이유(docs/policy-collection.md 제9조):
   Steam 프로필의 "게임 세부정보" 공개 설정이 꺼져 있으면 GetPlayerAchievements 가
   403(Profile is not public)으로 전량 실패하므로, gather 는 업적 없이 계속 진행했다.
   (데이터에는 없고 이 문서에만 기록한다.)
3. rating 일부 게임만 입력 — 30건만 값이 있고 나머지는 미입력이다.
   입력: 0분 3건 제외 뒤 4개 중 1개꼴 (정확히 30건). 미입력 케이스도 함께 존재한다.
   입력된 game_id: 440, 1237970, 588650, 219150, 1151640, 883710, 1245620, 230410, 553850, 311690, 1659040, 812140, 1091500, 291650, 1328670, 391540, 264710, 319630, 289070, 1142710, 294100, 703080, 1097150, 1868140, 1290000, 690790, 880940, 1332010, 1599600, 431960
4. 위시 ∩ 보유 = 0 — 위 "위시리스트" 절과 동일 (생성 시 교집합 assert 통과).
   중도 하차(dropped) 11건의 game_id: 105600, 1172470, 1244090, 1426210, 1977170, 2225070, 367520, 653530, 730, 945360, 956510

## 레코드 정합성 (생성 시 전건 assert — 위반 0건)

- status 분포 (보유 120건): playing 58 / completed 51 / dropped 11. 위시 51건은 전부 wishlist.
- 강제 규칙:
  1. 0분이면 playing/completed 불가 (미시작 하차로만 기록, 사유 "구매만 하고 실행하지 못함")
  2. playing/completed 이면 0분 초과
  3. completed 는 대표 장르 게임들의 중앙값 이상 (미달은 playing 으로 강등)
  4. 한줄평은 상태·별점대별 풀에서 선택 (별점 2.0 이하는 비판 풀, completed 에 "하는 중" 문구 금지)
  5. dropped 는 기피사유 1개 이상
  6. rating 입력은 0분 초과 게임에만
- 의도된 예외 (금지하지 않음): "길게 했는데 별점 낮음" / "짧게 했는데 별점 높음" —
  core 의 ratingPlaytimeGaps 가 노리는 신호이므로 허용한다.

## 장르 누락 참고 (함정이므로 의도적 유지)

- 장르가 비어 있는 4건도 플레이타임은 정상 배정받았다. 유틸리티성이라 길 수 있다:
   - game_id 1706830 (Muck): 4805분, 전체 120건 중 26위
   - game_id 1782210 (Crab Game): 1574분, 전체 120건 중 53위
   - game_id 223850 (3DMark): 371분, 전체 120건 중 78위
   - game_id 431960 (Wallpaper Engine): 159분, 전체 120건 중 91위
- 장르 누락 게임의 플레이타임 합 6909분 (전체 404642분의 1.7%)은
  장르 가중치 계산에서 어느 장르에도 귀속되지 않고 빠진다. 결함이 아니라 평가용 함정이다.

## 값 출처 구분

- 실제 Steam 공개 정보 차용: 게임명·appid·장르, 스팀 CDN 헤더 이미지 URL 패턴.
- 합성: playtime_minutes, last_played, rating, note, dislike_reasons, status,
  wishlisted 배정, taste-profile.json 의 모든 계산 입력이 되는 위 값들.
- 생략 (합성하지도 차용하지도 않음): developers / publishers / release_date.
  공개 메타 복원을 생략했으므로 전 게임 비어 있다.
