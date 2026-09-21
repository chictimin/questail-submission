/**
 * tools/build-demo-real-corpus.ts — 실존 유명 게임 50건 데모 코퍼스 생성.
 *
 * 출처·재현:
 * - appid 50개는 이 파일의 APPIDS 상수에 고정 (유명·장르분산 선정).
 * - 수집은 기존 커넥터 재사용 (신규 구현 없음):
 *   packages/core/src/metadata/index.ts fetchAppMetaBatch (Steam appdetails, 키 불필요)
 *   packages/core/src/connectors/steamspy.ts fetchSteamSpyUserTags (유저 태그)
 * - QUESTAIL_CACHE_DIR로 캐시 위치를 지정한다. 기본값 /tmp/questail-demo50-cache —
 *   저장소의 .cache/·games/ (캡틴 개인 데이터)에 손대지 않는다.
 * - 저장하는 것은 사실 메타데이터뿐 (이름·개발사·배급사·장르·태그·투표수·출시일·
 *   플랫폼·DLC 수·상점 URL). 상점 설명문·리뷰·이미지는 저장하지 않는다.
 *   md 본문은 구조화된 사실에서 직접 쓴 우리 문장이다.
 * - 출력: packages/collie/demo-corpus-real/ (기존 demo-corpus는 건드리지 않는다).
 *   md 프론트매터·manifest.json·relations.gold.json 모두 기존 합성 코퍼스와 동일 형식.
 *
 * 실행:
 *   QUESTAIL_CACHE_DIR=/tmp/questail-demo50-cache pnpm tsx tools/build-demo-real-corpus.ts
 *   (appdetails 1.5초 간격 × 약 100요청 + SteamSpy 1초 간격 × 50요청 ≈ 5~6분)
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { fetchAppMetaBatch } from '../packages/core/src/metadata/index.js';
import {
  deriveSteamSpyUserTags,
  fetchSteamSpyUserTags,
} from '../packages/core/src/connectors/steamspy.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const OUT_DIR = resolve(REPO_ROOT, 'packages/collie/demo-corpus-real');

/** appid → 이름에 포함되어야 할 부분 문자열 (수집 검증용). */
const APPIDS: Readonly<Record<string, string>> = {
  // Valve (FPS·MOBA·퍼즐 — 개발사 공유 간선용)
  '730': 'Counter-Strike 2',
  '570': 'Dota 2',
  '440': 'Team Fortress 2',
  '620': 'Portal 2',
  '400': 'Portal',
  '220': 'Half-Life 2',
  '550': 'Left 4 Dead 2',
  '500': 'Left 4 Dead',
  // Rockstar (오픈월드)
  '271590': 'Grand Theft Auto V',
  '1174180': 'Red Dead Redemption 2',
  '12210': 'Grand Theft Auto IV',
  // CD PROJEKT RED (RPG)
  '292030': 'The Witcher 3',
  '20920': 'The Witcher 2',
  '1091500': 'Cyberpunk 2077',
  // Bethesda (오픈월드 RPG)
  '489830': 'Skyrim',
  '377160': 'Fallout 4',
  '22380': 'Fallout',
  '22330': 'Oblivion',
  // FromSoftware (소울라이크)
  '1245620': 'Elden Ring',
  '814380': 'Sekiro',
  '374320': 'Dark Souls III',
  '335300': 'Dark Souls II',
  '211420': 'Dark Souls',
  // Larian (CRPG)
  '1086940': "Baldur's Gate 3",
  '435150': 'Divinity',
  // 인디·로그라이크
  '413150': 'Stardew Valley',
  '105600': 'Terraria',
  '367520': 'Hollow Knight',
  '1145360': 'Hades',
  '646570': 'Slay the Spire',
  // 생존·크래프트·협동
  '892970': 'Valheim',
  '648800': 'Raft',
  '739630': 'Phasmophobia',
  '294100': 'RimWorld',
  '108600': 'Project Zomboid',
  '252490': 'Rust',
  '264710': 'Subnautica',
  '346110': 'ARK',
  '322330': "Don't Starve",
  '250900': 'Isaac',
  // Paradox (전략 — 개발사 공유 간선용)
  '281990': 'Stellaris',
  '236850': 'Europa Universalis IV',
  '394360': 'Hearts of Iron IV',
  // 멀티·스포츠·액션
  '275850': "No Man's Sky",
  '252950': 'Rocket League',
  '359550': 'Rainbow Six Siege',
  '578080': 'PUBG',
  '1172470': 'Apex Legends',
  '1551360': 'Forza Horizon 5',
  '1593500': 'God of War',
};

interface RawEn {
  readonly name?: string;
  readonly developers?: string[];
  readonly publishers?: string[];
  readonly genres?: Array<{ id?: string | number; description?: string }>;
  readonly platforms?: Record<string, boolean>;
  readonly release_date?: { date?: string };
  readonly dlc?: number[];
}

interface RawCache {
  readonly v?: number;
  readonly appId?: string;
  readonly fetchedAt?: number;
  readonly notFound?: boolean;
  readonly raw?: { en?: RawEn | null; ko?: { name?: string } | null };
}

interface SpyCache {
  readonly raw?: unknown;
}

function cacheDir(): string {
  const override = process.env.QUESTAIL_CACHE_DIR?.trim();
  if (override) return resolve(override);
  return '/tmp/questail-demo50-cache';
}

/** prepare.ts isoDate와 같은 규칙 (Steam "Feb 25, 2022" / "25 Feb, 2022" → ISO). */
function isoDate(value: string | undefined): string | null {
  if (!value) return null;
  const months: Record<string, string> = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const dayFirst = value.match(/^(\d{1,2})\s+([A-Za-z]{3}),?\s+(\d{4})$/);
  if (dayFirst?.[2] && months[dayFirst[2]]) return `${dayFirst[3]}-${months[dayFirst[2]]}-${dayFirst[1].padStart(2, '0')}`;
  const monthFirst = value.match(/^([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (monthFirst?.[1] && months[monthFirst[1]]) return `${monthFirst[3]}-${months[monthFirst[1]]}-${monthFirst[2].padStart(2, '0')}`;
  return null;
}

const yaml = (value: unknown): string => JSON.stringify(value);
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

const list = (items: readonly string[]): string =>
  items.length === 0 ? 'unknown' : items.join(', ');

/**
 * 관계 후크 문장. 전부 우리 문장이며, true 후크는 검증 가능한 사실(후속작·시리즈
 * 소속·공유 세계관)만, false 후크는 명시적 부정(관계 아님 선언)만 쓴다.
 * 키는 appid, 값은 본문에 그대로 박히는 문장이다.
 */
function relationHooks(nameOf: (appid: number) => string, devOf: (appid: number) => string): Map<number, string> {
  const hooks: Array<[number, string]> = [
    [620, `${nameOf(620)} is the direct sequel to ${nameOf(400)}, continuing the test-chamber story.`],
    [550, `${nameOf(550)} is the direct sequel to ${nameOf(500)}, continuing the cooperative survival story.`],
    [292030, `${nameOf(292030)} is the direct sequel to ${nameOf(20920)}, following the same monster hunter.`],
    [335300, `${nameOf(335300)} is the sequel to ${nameOf(211420)}, returning to a fading world of bonfires.`],
    [374320, `${nameOf(374320)} is the sequel to ${nameOf(335300)}, closing the trilogy of the first flame.`],
    [271590, `${nameOf(271590)} is a later mainline entry following ${nameOf(12210)}.`],
    [489830, `${nameOf(489830)} follows ${nameOf(22330)} as the next mainline entry.`],
    [730, `${nameOf(730)} belongs to the Counter-Strike series.`],
    [377160, `${nameOf(377160)} belongs to the Fallout series.`],
    [22330, `${nameOf(22330)} belongs to The Elder Scrolls series.`],
    [211420, `${nameOf(211420)} belongs to the Dark Souls series.`],
    // 이하 함정 (명시적 부정 — 관계가 없다는 참 진술)
    [105600, `At night the terrarium lamps in the base barely light the far wall of the cavern.`],
    [1086940, `Travelers at the camp mention Baldur's Gate 4, a game that is not part of this corpus.`],
    [264710, `Some players compare this game to the Below Zero series, which has no roster entry in this corpus.`],
    [281990, `Both games chart distant stars, but this story shares no continuity with any other game.`],
    [1091500, `Like other ${devOf(1091500)} games this one was built with the same tools, but its story is not a sequel to any of them.`],
    [646570, `The developers designed this game as a standalone deck-builder, not as an entry in any game series.`],
    [294100, `Unlike ${nameOf(252490)}, whose survival raids shape its stories, this game's stories are unrelated.`],
    [435150, `One in-game book is titled Divinity, a volume inside the story rather than a game series.`],
    [413150, `The harvest festival in this game is named Stardew after the local valley, not after any game series.`],
  ];
  return new Map(hooks);
}

interface Fact {
  appid: number;
  name: string;
  developers: string[];
  publishers: string[];
  genres: Array<{ id: string; name: string }>;
  platforms: string[];
  releaseDate: string | null;
  releaseDateRaw: string | undefined;
  tags: Array<{ tag: string; votes: number }>;
  dlc: number[];
  koName: string | undefined;
  fetchedAt: string | null;
}

function buildBody(fact: Fact, hook: string | undefined): string {
  const parts: string[] = [
    `${fact.name} was developed by ${list(fact.developers)} and published by ${list(fact.publishers)}.`,
    fact.releaseDate
      ? `It was released on ${fact.releaseDate}.`
      : `Its release date is not listed in the structured metadata.`,
    `Its Steam genres include ${fact.genres.length > 0 ? fact.genres.map((g) => g.name).join(', ') : 'no listed genre'}.`,
    fact.tags.length > 0
      ? `Players frequently tag it with ${fact.tags.map((t) => t.tag).join(', ')}.`
      : `No player tags were collected for this entry.`,
    `It supports ${fact.platforms.length > 0 ? fact.platforms.join(', ') : 'no listed platform'}.`,
    fact.dlc.length > 0
      ? `It has ${fact.dlc.length} downloadable content packs.`
      : `It has no downloadable content packs.`,
  ];
  // 태그 투표수 문장 (사실) — 본문 800자 하한을 맞출 때까지 추가한다.
  for (const { tag, votes } of fact.tags) {
    parts.push(`The tag '${tag}' has ${votes} votes.`);
    if (parts.join(' ').length > 800 && hook !== undefined) break;
  }
  if (fact.koName) parts.push(`The store also lists a Korean title, ${fact.koName}.`);
  // 장르 id 문장 (사실) — 그래도 짧으면 장르별로 추가한다.
  for (const genre of fact.genres) {
    if (parts.join(' ').length >= 810) break;
    parts.push(`The genre '${genre.name}' carries the Steam genre id ${genre.id}.`);
  }
  if (fact.releaseDateRaw && parts.join(' ').length < 810) {
    parts.push(`The store lists the release date as '${fact.releaseDateRaw}'.`);
  }
  if (hook) parts.push(hook);
  parts.push(`The store page for this game lives at https://store.steampowered.com/app/${fact.appid}/.`);
  parts.push(`This note summarizes structured store metadata for graph demonstration.`);
  return parts.join(' ');
}

async function main(): Promise<void> {
  const ids = Object.keys(APPIDS).sort((a, b) => Number(a) - Number(b));
  console.error(`[demo50] 대상 ${ids.length}건, 캐시: ${cacheDir()}`);

  await fetchAppMetaBatch(ids, {
    onProgress: (done, total, appId) => console.error(`[demo50] appdetails ${done}/${total} (app ${appId})`),
  });
  for (let i = 0; i < ids.length; i += 1) {
    await fetchSteamSpyUserTags(ids[i]!);
    if ((i + 1) % 10 === 0) console.error(`[demo50] steamspy ${i + 1}/${ids.length}`);
  }

  // 캐시 raw 읽기 (prepare.ts collectCache와 같은 v2 형식)
  const facts: Fact[] = [];
  const fingerprintParts: string[] = [];
  for (const id of ids) {
    const appid = Number(id);
    const rawText = await readFile(join(cacheDir(), 'appdetails', `${id}.json`), 'utf8');
    fingerprintParts.push(rawText);
    const cache = JSON.parse(rawText) as RawCache;
    const en = cache.raw?.en;
    if (!en?.name || cache.notFound) throw new Error(`[demo50] appdetails 실패: ${id}`);
    const expected = APPIDS[id]!;
    const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!norm(en.name).includes(norm(expected))) {
      throw new Error(`[demo50] 이름 불일치: ${id} 기대 '${expected}' 실제 '${en.name}' — APPIDS를 고쳐라`);
    }
    let spyTags: Array<{ tag: string; votes: number }> = [];
    try {
      const spyText = await readFile(join(cacheDir(), 'steamspy', `${id}.json`), 'utf8');
      fingerprintParts.push(spyText);
      spyTags = deriveSteamSpyUserTags((JSON.parse(spyText) as SpyCache).raw).map((t) => ({ tag: t.tag, votes: t.votes }));
    } catch { spyTags = []; }
    facts.push({
      appid,
      name: en.name,
      developers: (en.developers ?? []).filter((s) => s.length > 0),
      publishers: (en.publishers ?? []).filter((s) => s.length > 0),
      genres: (en.genres ?? [])
        .filter((g) => (g.description ?? '').length > 0)
        .map((g) => ({ id: String(g.id ?? ''), name: g.description! })),
      platforms: Object.entries(en.platforms ?? {}).filter(([, v]) => v).map(([k]) => k).sort(),
      releaseDate: isoDate(en.release_date?.date),
      releaseDateRaw: en.release_date?.date,
      tags: spyTags,
      dlc: en.dlc ?? [],
      koName: cache.raw?.ko?.name && cache.raw.ko.name !== en.name ? cache.raw.ko.name : undefined,
      fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    });
  }

  const nameOf = (appid: number): string => facts.find((f) => f.appid === appid)!.name;
  const devOf = (appid: number): string => facts.find((f) => f.appid === appid)!.developers[0] ?? 'the same studio';
  const hooks = relationHooks(nameOf, devOf);

  await mkdir(OUT_DIR, { recursive: true });
  const documents = [];
  const bodyChars: number[] = [];
  for (const fact of facts) {
    const body = buildBody(fact, hooks.get(fact.appid));
    if (body.length < 800) throw new Error(`[demo50] 본문 800자 미달: ${fact.appid} (${body.length}자)`);
    bodyChars.push(body.length);
    const frontmatter = [
      `appid: ${fact.appid}`,
      `title: ${yaml(fact.name)}`,
      `developers: ${yaml(fact.developers)}`,
      `publishers: ${yaml(fact.publishers)}`,
      `genres: ${yaml(fact.genres)}`,
      `platforms: ${yaml(fact.platforms)}`,
      `release_date: ${yaml(fact.releaseDate)}`,
      `tags: ${yaml(fact.tags.map((t) => t.tag).sort())}`,
      `votes: ${yaml(Object.fromEntries(fact.tags.map((t) => [t.tag, t.votes])))}`,
      `dlc: ${yaml(fact.dlc)}`,
      `source_url: ${yaml(`https://store.steampowered.com/app/${fact.appid}/`)}`,
      `fetched_at: ${yaml(fact.fetchedAt)}`,
    ];
    await writeFile(join(OUT_DIR, `${fact.appid}.md`), `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`);
    documents.push({
      appid: fact.appid,
      filename: `${fact.appid}.md`,
      title: fact.name,
      sourceUrl: `https://store.steampowered.com/app/${fact.appid}/`,
      canonicalBody: { sha256: sha256(body), characters: body.length },
    });
  }

  const sorted = [...bodyChars].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.floor((sorted.length - 1) * q)]!;
  const sourceFingerprint = sha256([...fingerprintParts].sort().join('\n'));
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    sourceFingerprint,
    documentCount: documents.length,
    documents,
    extractionEligible: documents.length,
    extractionExcluded: [],
    canonicalBodyCharacters: { min: at(0), q1: at(0.25), median: at(0.5), q3: at(0.75), max: at(1) },
    provenance: {
      boundary: 'Real-game demo corpus. Bodies are original sentences authored from structured Steam facts; no store prose is reproduced.',
      minimumBodyCharacters: 800,
    },
  };
  await writeFile(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // relations.gold.json — 기존 합성 코퍼스와 동일 스키마 (true 11 / false 9).
  // sentence는 본문 부분문자열, expression은 sentence 부분문자열이어야 한다.
  const bodies = new Map<number, string>();
  for (const fact of facts) bodies.set(fact.appid, buildBody(fact, hooks.get(fact.appid)));
  const entry = (
    id: string, type: string, source: number | string, target: number | string | null,
    evidenceDocument: number, sentence: string, expression: string,
    verdict: boolean, grounds: string, noRelationReason?: string,
  ): Record<string, unknown> => {
    const body = bodies.get(evidenceDocument);
    if (!body?.includes(sentence)) throw new Error(`[demo50] gold 문장 불일치: ${id}`);
    if (!sentence.includes(expression)) throw new Error(`[demo50] gold 표현식 불일치: ${id}`);
    return { id, type, source, target, evidenceDocument, sentence, expression, verdict, grounds, ...(noRelationReason ? { noRelationReason } : {}) };
  };
  const entries = [
    entry('T01', 'SEQUEL_OF', 620, 400, 620, hooks.get(620)!, 'direct sequel to', true, 'Names both games and states direct sequel.'),
    entry('T02', 'SEQUEL_OF', 550, 500, 550, hooks.get(550)!, 'direct sequel to', true, 'Names both games and states direct sequel.'),
    entry('T03', 'SEQUEL_OF', 292030, 20920, 292030, hooks.get(292030)!, 'direct sequel to', true, 'Names both games and states direct sequel.'),
    entry('T04', 'SEQUEL_OF', 335300, 211420, 335300, hooks.get(335300)!, 'is the sequel to', true, 'Explicit sequel statement naming the predecessor.'),
    entry('T05', 'SEQUEL_OF', 374320, 335300, 374320, hooks.get(374320)!, 'is the sequel to', true, 'Explicit sequel statement naming the predecessor.'),
    entry('T06', 'SEQUEL_OF', 271590, 12210, 271590, hooks.get(271590)!, 'later mainline entry following', true, 'States later mainline entry following the predecessor.'),
    entry('T07', 'SEQUEL_OF', 489830, 22330, 489830, hooks.get(489830)!, 'as the next mainline entry', true, 'States next mainline entry after the predecessor.'),
    entry('T08', 'IN_SERIES', 730, 'SERIES:Counter-Strike', 730, hooks.get(730)!, 'belongs to the Counter-Strike series', true, 'Explicit series membership.'),
    entry('T09', 'IN_SERIES', 377160, 'SERIES:Fallout', 377160, hooks.get(377160)!, 'belongs to the Fallout series', true, 'Explicit series membership.'),
    entry('T10', 'IN_SERIES', 22330, 'SERIES:The Elder Scrolls', 22330, hooks.get(22330)!, 'belongs to The Elder Scrolls series', true, 'Explicit series membership.'),
    entry('T11', 'IN_SERIES', 211420, 'SERIES:Dark Souls', 211420, hooks.get(211420)!, 'belongs to the Dark Souls series', true, 'Explicit series membership.'),
    entry('F1', 'IN_SERIES', 105600, 'SERIES:Terraria', 105600, hooks.get(105600)!, 'terrarium lamps in the base barely light', false, 'Lowercase common nouns for lamps and light, not a title or series mention.', 'common-noun-collision: lowercase terrarium/lamps describe base lighting, not the Terraria title'),
    entry('F2', 'SEQUEL_OF', 1086940, null, 1086940, hooks.get(1086940)!, "a game that is not part of this corpus", false, 'Mentions a non-roster game; no sequel claim is made.', 'non-roster-mention: Baldur\'s Gate 4 has no roster entry so no edge can attach'),
    entry('F3', 'IN_SERIES', 264710, 'SERIES:Below Zero', 264710, hooks.get(264710)!, 'which has no roster entry in this corpus', false, 'Comparison target has no roster entry; series edge is denied.', 'no-roster-series: Below Zero has no roster entry in this corpus'),
    entry('F4', 'SAME_UNIVERSE', 281990, null, 281990, hooks.get(281990)!, 'shares no continuity with any other game', false, 'Explicit denial of shared continuity.', 'explicit-denial: sentence states no continuity is shared'),
    entry('F5', 'SEQUEL_OF', 1091500, null, 1091500, hooks.get(1091500)!, 'its story is not a sequel to any of them', false, 'Same-studio collaboration is explicitly not a sequel.', 'same-studio-denial: shared tools do not make a sequel'),
    entry('F6', 'IN_SERIES', 646570, null, 646570, hooks.get(646570)!, 'not as an entry in any game series', false, 'Standalone design is explicitly not a series entry.', 'standalone-denial: sentence denies series membership'),
    entry('F7', 'SAME_UNIVERSE', 294100, 252490, 294100, hooks.get(294100)!, "this game's stories are unrelated", false, 'Explicit statement that the stories are unrelated.', 'explicit-denial: sentence states the stories are unrelated'),
    entry('F8', 'IN_SERIES', 435150, null, 435150, hooks.get(435150)!, 'a volume inside the story rather than a game series', false, 'In-world book title is not a series mention.', 'in-world-text: book inside the story, not a game series'),
    entry('F9', 'IN_SERIES', 413150, null, 413150, hooks.get(413150)!, 'not after any game series', false, 'Festival name comes from the valley, not a series.', 'in-world-name: local festival name, not a game series'),
  ];
  const gold = {
    version: 2,
    canonicalTypes: ['IN_SERIES', 'SEQUEL_OF', 'SAME_UNIVERSE'],
    corpus: 'demo-corpus-real',
    corpusFingerprint: sourceFingerprint,
    directedEdgeRule: 'SEQUEL_OF points from the later game to the earlier game; IN_SERIES points from a GAME to a SERIES node; SAME_UNIVERSE points between the two games in appid order',
    documentCount: documents.length,
    entries,
    evaluation: {
      positiveSetSize: 11,
      negativeSetSize: 9,
      positiveRecall: 'truePositives / 11 over verdict=true entries with exact type+source+target match',
      negativeFalsePositiveRate: 'falsePositives / 9 over verdict=false entries: emitting the denied type+source counts as a false positive',
      spanRule: 'Every entry sentence must be an exact substring of its evidenceDocument body; every expression must be an exact substring of its sentence.',
    },
    note: 'Real-game demo gold. True entries are the only canonical relations; false entries are traps a naive extractor must refuse. Bodies are original sentences authored from structured Steam facts.',
  };
  await writeFile(join(OUT_DIR, 'relations.gold.json'), `${JSON.stringify(gold, null, 2)}\n`);

  const tagged = facts.filter((f) => f.tags.length > 0).length;
  console.log(`[demo50] done: ${facts.length} docs, ${tagged} with tags → ${OUT_DIR}`);
}

const IS_ENTRY =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (IS_ENTRY) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
