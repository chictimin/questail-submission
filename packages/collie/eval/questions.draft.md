# 평가셋 질문 문안 초안 (12문항)

> `minimumLevel`·`expectedPaths`는 미확정이다. 탐색 엔진을 돌린 뒤 실측으로 교체한다.
> df 수치는 코퍼스 126건 실측(2026-09-21).

md는 근거·폐기 이력·규칙, json은 id·문안·기대값, 어긋나면 json이 맞다.

## 규칙

- **gold path는 non-TAG 간선을 최소 1개 포함한다** — `DEVELOPED_BY` · `PUBLISHED_BY` · 본문 추출 관계 중 하나.
  같은 태그를 두 번 건너는 경로는 형태만 2홉이고 태그 1회 조회로 나오는 답이라 멀티홉을 증명하지 못한다.
- 태그는 **끝 필터**로 쓴다. 다리로 쓰면 질문이 "~좋아하는데"로 길어지고 부자연스러워진다.
- 다리를 셋으로 섞는다. 개발사만 쓰면 12문항이 전부 "X 만든 데서 낸…"이 된다.

| 다리 | 문항 |
|---|---|
| `DEVELOPED_BY` | Q01 · Q03 · Q04 · Q08 |
| `PUBLISHED_BY` | Q02 · Q06 |
| 본문 추출 관계 (`SEQUEL_OF`) | Q07 |
| 허브 직접 사실 | Q09 |
| (혼합 3홉) | Q05 |

---

## L0 — 엄격 정책에서 바로 닿는다 (4)

### Q01 · answer
**몬헌 만든 데서 낸 다른 게임 중에 서바이벌 호러 있어?**

`Monster Hunter Wilds` → CAPCOM(df 8) → `Resident Evil 4` · `2` · `3` → `Survival Horror`(df 9)

답이 복수다. 집합으로 채점한다.

### Q02 · answer
**보더랜드 낸 데서 나온 다른 게임 중에 FPS 있어?**

`Borderlands 4` → 2K(df 8, 퍼블리셔) → `BioShock Infinite` → `FPS`(df 13)

퍼블리셔 다리. 개발사가 전부 다른 게임들이 2K 하나로 묶인다.

### Q03 · answer
**서브노티카 만든 데서 낸 다른 게임 중에 탐험 요소 있는 거?**

`Subnautica` → Unknown Worlds(df 3) → `Subnautica: Below Zero` → `Exploration`(df 15)

태그가 L0 상한 경계다.

### Q04 · answer
**발더스게이트 만든 데서 낸 다른 게임 중에 턴제 있어?**

`Baldur's Gate 3` → Larian(df 3) → `Divinity: Original Sin - Enhanced Edition` → `Turn-Based`(df 7)

---

## L1 — 반경 3이 필요하다 (2)

### Q05 · answer
**하데스랑 같은 로그라이크 중에 다키스트던전 만든 데 게임 있어?**

`Hades` → `Rogue-like`(df 9) → `Darkest Dungeon II` → Red Hook(df 2) → `Darkest Dungeon`

태그와 개발사를 섞는다. 태그가 앞에 오지만 다리가 태그 하나뿐이 아니라 의사 멀티홉이 아니다.

### Q06 · answer
**바이오쇼크랑 같은 FPS 중에 위쳐 만든 데 게임 있어?**

`BioShock Infinite` → `FPS`(df 13) → `Cyberpunk 2077` → CD PROJEKT RED(df 2) → `The Witcher 2`

---

## L2 — 본문 추출 관계가 필요하다 (1)

### Q07 · answer
**서브노티카 후속작 갖고 있어?**

`Subnautica` → `SEQUEL_OF` → `Subnautica: Below Zero` · `Subnautica 2`

`SEQUEL_OF`는 LLM 추출 간선이라 L2에서 처음 열린다. **품질 게이트가 평가에 직접 반영되는 유일한 문항**이다 — 게이트를 떨어뜨려 결정적 속성 그래프로 폴백하면 이 문항은 개발사 다리로 대체되거나 빠진다.

> 초안은 `IN_SERIES`(`서브노티카 시리즈 뭐뭐 갖고 있어?`)였다. 실데이터 **본문**에서 `IN_SERIES`를 끄면서 교체했다 — Steam 본문은 시리즈 소속을 서술하지 않고 제목에 담는다.
>
> 다만 시리즈 자체를 포기한 것은 아니다. **제목 + 출시일로 결정적으로 뽑는다**(27 `IN_SERIES` + 10 `SEQUEL_OF` = 37건, 본문 LLM 2건의 18배). 그러므로 이 문항은 `SEQUEL_OF`가 결정적 간선으로 성립한 뒤에도 유효하다. 다만 그 경우 L2가 아니라 L0에서 풀릴 수 있으므로 **레벨은 실측으로 확정한다.**

## L3 — 태그 상한을 넘겨야 한다 (1)

### Q08 · answer
**시스템쇼크 만든 데서 낸 다른 게임도 슈터야?**

`System Shock 2` → Irrational(df 2) → `BioShock Infinite` → `Shooter`(df 18)

`Shooter` df 18이 L0 상한 15를 넘고 L3 상한 25 안에 든다.

---

## L4 — 사용자가 허브를 명시했다 (1)

### Q09 · answer
**싱글로 할 만한 것 중에 다키스트던전 만든 데 게임 있어?**

`Darkest Dungeon` → Red Hook(df 2) → `Darkest Dungeon II` + `Singleplayer`(df 59) 직접 사실

`Singleplayer`는 denylist 허브다. **다리로는 끝까지 안 쓰고**, 사용자가 명시했으니 시작·종점의 직접 사실로만 확인한다.

---

## abstain — 거절이 정답 (3)

### Q10 · 시작 개체 없음
**엘든 링 만든 데서 낸 다른 게임 있어?**

`Elden Ring`도 FromSoftware도 코퍼스에 없다(실측 확인). **사다리를 타기 전에 즉시 거절**한다.

보여줄 것 — 시작 개체를 못 찾았다는 사실 한 줄. 시도한 레벨·차단된 허브는 없다.

> 존재하지 않는 제목이 아니라 **실재하지만 라이브러리에 없는 게임**이라는 점이 중요하다. 실사용에 가깝고 더 어렵다.

### Q11 · 모든 경로 없음
**알란 웨이크 만든 데 게임 중에 협동 되는 거 있어?**

시작 개체는 잡히고 Remedy(df 2)로 `Alan Wake's American Nightmare`까지 닿는다. 그런데 양쪽 태그 전수 확인 결과 `Co-op`·`Online Co-Op`·`Multiplayer`·`Local Co-Op`가 **둘 다에 없다**. L4까지 넓혀도 답이 안 생긴다.

보여줄 것 — 시도한 레벨(L0~L4), 도달한 후보와 탈락 이유. 없는 관계를 추정하지 않는다.

### Q12 · 허브 외 근거 없음
**후보 미확정.** P2-C 그래프가 나오면 확정한다.

조건 — 시작 개체가 잡히고 후보도 있는데, **연결 근거가 허브 태그(`Singleplayer`·`Multiplayer`·`Action`·`Adventure`)뿐인 경우**. 허브를 다리로 풀면 답이 나오지만 SPEC 4절이 끝까지 금지한다. L4의 direct-fact-only도 시작·종점 사실로만 쓸 뿐 다리로는 안 쓴다.

Q11과의 차이 — Q11은 후보까지 갔는데 **조건이 미충족**, Q12는 **연결 자체가 허브로만 가능**.

> 초안 단계에서 Valve 게임(`Counter-Strike` → `Portal`·`Half-Life`)으로 잡았다가 폐기했다. **셋 다 라이브러리에 없고** 캡틴이 가진 Valve 게임은 `Left 4 Dead 2` 하나뿐이라(df 1) 개발사 다리도 안 된다. 그대로 뒀으면 Q10과 같은 "시작 개체 없음"이 되어 거절 유형이 셋이 아니라 둘이 됐다.

---

## 배분

| | 건수 | 문항 |
|---|---|---|
| L0 | 4 | Q01 · Q02 · Q03 · Q04 |
| L1 반경 3 | 2 | Q05 · Q06 |
| L2 본문 관계 | 1 | Q07 |
| L3 상한 완화 | 1 | Q08 |
| L4 허브 직접 사실 | 1 | Q09 |
| abstain | 3 | Q10 · Q11 · Q12 |

## 폐기한 초안

| | 왜 |
|---|---|
| "국산 게임으로는 뭐 있어?" | **국적이 그래프에 없다.** 개발사 국적은 Steam appdetails에 없는 필드다. 정답으로 잡았던 `TROUBLESHOOTER`(Dandylion)는 실재하지만 질문의 제약과 경로가 안 맞는다 |
| "데빌메이크라이 시리즈로는 뭐부터 해야 돼?" | 순서·추천을 묻는다. PRD가 추천을 M4로 이첩했고 출시 순서는 속성이지 경로가 아니다 |
| "카스 만든 밸브 게임 중에…" | Valve 게임 부재 (위 Q12 참조) |
| 태그를 앞 다리로 쓰는 문항 전부 | "~좋아하는데"로 정당화하느라 질문이 길어졌다. 태그를 끝 필터로 옮기면 짧아지면서 멀티홉도 유지된다 |
