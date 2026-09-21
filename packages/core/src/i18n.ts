/**
 * 간단한 i18n — 한국어(기본) + 영어
 *
 * 감지 순서: config language > LANG 환경변수 > 'ko'
 */

export type Locale = 'ko' | 'en';

const STRINGS: Record<Locale, Record<string, string | ((...args: string[]) => string)>> = {
  ko: {
    // login
    login_title: '=== QuestTail 로그인 ===',
    login_api_key_needed: 'Steam API 키가 필요합니다.',
    login_api_key_url: '발급: https://steamcommunity.com/dev/apikey',
    login_current_key: (v: string) => `현재 저장된 키: ${v}`,
    login_ask_reuse_key: '이 키를 사용할까요? (Y/n): ',
    login_ask_new_key: 'Steam API 키를 입력하세요: ',
    login_key_required: 'API 키는 필수입니다.',
    login_id_needed: 'Steam 계정 ID가 필요합니다.',
    login_id_help1: '방법 1) Steam 클라이언트 → 프로필 → 프로필 페이지 URL 복사',
    login_id_help2: '방법 2) 숫자만 알고 있으면 그대로 입력 가능 (17자리)',
    login_ask_reuse_id: '이 ID를 사용할까요? (Y/n): ',
    login_ask_new_id: 'Steam 프로필 URL 또는 SteamID64를 입력하세요: ',
    login_id_required: 'SteamID는 필수입니다.',
    login_resolving: 'SteamID 확인 중...',
    login_resolve_fail: (e: string) => `SteamID 변환 실패: ${e}`,
login_done: (path: string) => `✅ Sniff 완료. 저장 위치: ${path}`,
  login_ask_import_now: '\n지금 Steam 라이브러리를 수집할까요? (gather) (Y/n): ',
    login_saved: (key: string) => `✅ ${key} 저장 완료. 다음부터는 생략됩니다.`,
    login_ask_save: 'config에 저장할까요? (Y/n): ',

    // config
    config_not_set: (key: string) => `설정되지 않음: ${key}`,
    config_saved: (key: string, path: string) => `✅ ${key} 저장 완료 (${path})`,
    config_deleted: (key: string) => `✅ ${key} 삭제 완료`,
    config_get_usage: '사용법: questail config get <key>',
    config_set_usage: '사용법: questail config set <key> <value>',
    config_delete_usage: '사용법: questail config delete <key>',

    // import
    import_fetching: (id: string) => `Steam 라이브러리를 확인 중입니다... (SteamID: ${id})`,
    import_summary: (count: string, dir: string) => `${count}개 게임 발견! 꼬리가 가리키는 방향 → ${dir}/`,
    import_item: (title: string, hours: string, path: string) => `  ✓ ${title} (${hours}h)`,
    import_done: (count: string, dir: string) => `✅ ${count}개 게임, 다 가져왔어요! 저장 위치: ${dir}/`,
    import_steam_id_resolved: (input: string, id: string) => `✓ SteamID 확인: ${input} → ${id}`,

    // errors
    error_api_key_missing: [
      'Steam API 키가 설정되지 않았습니다.',
      '',
      '  questail config set steam-api-key <발급받은_키>',
      '',
      '키 발급: https://steamcommunity.com/dev/apikey',
    ].join('\n'),
    error_steam_id_missing: [
      'SteamID가 설정되지 않았습니다.',
      '',
      '  questail config set steam-id <SteamID64 또는 프로필 URL>',
      '  또는: questail gather steam <SteamID64>',
    ].join('\n'),
    error_steam_api: (msg: string) => `오류: ${msg}`,
    error: (msg: string) => `오류: ${msg}`,

    // general
    usage_header: '사용법:',
    usage_import: '  questail gather steam [<id>] [-o <dir>]',
    usage_login: '  questail sniff                       # 대화형 설정',
    usage_config_set: '  questail config set <key> <value>',
    usage_config_get: '  questail config get <key>',
    usage_config_delete: '  questail config delete <key>',
    unknown_cmd: '알 수 없는 명령어입니다.',
  },

  en: {
    login_title: '=== QuestTail Login ===',
    login_api_key_needed: 'A Steam API key is required.',
    login_api_key_url: 'Get one at: https://steamcommunity.com/dev/apikey',
    login_current_key: (v: string) => `Current key: ${v}`,
    login_ask_reuse_key: 'Use this key? (Y/n): ',
    login_ask_new_key: 'Enter your Steam API key: ',
    login_key_required: 'API key is required.',
    login_id_needed: 'Your Steam account ID is needed.',
    login_id_help1: 'Method 1) Steam client → Profile → copy profile page URL',
    login_id_help2: 'Method 2) Just paste the numeric ID (17 digits)',
    login_ask_reuse_id: 'Use this ID? (Y/n): ',
    login_ask_new_id: 'Enter Steam profile URL or SteamID64: ',
    login_id_required: 'SteamID is required.',
    login_resolving: 'Resolving SteamID...',
    login_resolve_fail: (e: string) => `SteamID resolve failed: ${e}`,
    login_done: (path: string) => `✅ Sniff complete. Saved at: ${path}`,
    login_ask_import_now: '\nGather your Steam library now? (Y/n): ',
    login_saved: (key: string) => `✅ ${key} saved. Will be auto-loaded next time.`,
    login_ask_save: 'Save to config? (Y/n): ',

    config_not_set: (key: string) => `Not configured: ${key}`,
    config_saved: (key: string, path: string) => `✅ ${key} saved (${path})`,
    config_deleted: (key: string) => `✅ ${key} deleted`,
    config_get_usage: 'Usage: questail config get <key>',
    config_set_usage: 'Usage: questail config set <key> <value>',
    config_delete_usage: 'Usage: questail config delete <key>',

    import_fetching: (id: string) => `Checking your Steam library... (SteamID: ${id})`,
    import_summary: (count: string, dir: string) => `Found ${count} games! Tail pointing at → ${dir}/`,
    import_item: (title: string, hours: string, path: string) => `  ✓ ${title} (${hours}h)`,
    import_done: (count: string, dir: string) => `✅ ${count} games gathered! Saved at: ${dir}/`,
    import_steam_id_resolved: (input: string, id: string) => `✓ SteamID resolved: ${input} → ${id}`,

    error_api_key_missing: [
      'Steam API key is not configured.',
      '',
      '  questail config set steam-api-key <your_key>',
      '',
      'Get a key: https://steamcommunity.com/dev/apikey',
    ].join('\n'),
    error_steam_id_missing: [
      'SteamID is not configured.',
      '',
      '  questail config set steam-id <SteamID64 or profile URL>',
      '  or: questail gather steam <SteamID64>',
    ].join('\n'),
    error_steam_api: (msg: string) => `Error: ${msg}`,
    error: (msg: string) => `Error: ${msg}`,

    usage_header: 'Usage:',
    usage_import: '  questail gather steam [<id>] [-o <dir>]',
    usage_login: '  questail sniff                       # Interactive setup',
    usage_config_set: '  questail config set <key> <value>',
    usage_config_get: '  questail config get <key>',
    usage_config_delete: '  questail config delete <key>',
    unknown_cmd: 'Unknown command.',
  },
};

export function detectLocale(): Locale {
  const envLang = process.env.LANG ?? '';
  if (envLang.startsWith('ko')) return 'ko';
  return 'en';
}

/** i18n 인스턴스 — 주어진 locale로 문자열을 찾는다 */
export function t(locale: Locale, key: string, ...args: string[]): string {
  const entry = STRINGS[locale]?.[key] ?? STRINGS.en[key] ?? key;
  if (typeof entry === 'function') return (entry as (...a: string[]) => string)(...args);
  return entry;
}
