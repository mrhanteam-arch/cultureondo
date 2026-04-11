// ─────────────────────────────────────────────
//  컬처온도 Service Worker
//  버전을 올리면 activate 시 구버전 캐시 자동 삭제
// ─────────────────────────────────────────────
const CACHE_VERSION = 'v2';

const CACHE_NAMES = {
  static:  'co-static-'  + CACHE_VERSION,   // HTML, JS, manifest
  events:  'co-events-'  + CACHE_VERSION,   // events.json (Network-first)
  images:  'co-images-'  + CACHE_VERSION,   // 포스터 이미지 (Cache-first, 7일)
};

// 설치 시 프리캐시할 정적 자산
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── install: 정적 자산 프리캐시 ──────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAMES.static)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())   // 대기 없이 즉시 활성화
  );
});

// ── activate: 구버전 캐시 정리 ───────────────────
self.addEventListener('activate', event => {
  const currentCaches = new Set(Object.values(CACHE_NAMES));

  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => !currentCaches.has(key))  // 현재 버전에 없는 캐시
          .map(key => {
            console.log('[SW] 구버전 캐시 삭제:', key);
            return caches.delete(key);
          })
      ))
      .then(() => self.clients.claim())  // 기존 탭도 즉시 새 SW가 제어
  );
});

// ── fetch: 요청 타입별 전략 분기 ─────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // events.json — Network-first
  if (url.pathname.endsWith('events.json')) {
    event.respondWith(networkFirst(request, CACHE_NAMES.events));
    return;
  }

  // 이미지 (wsrv.nl 프록시 포함) — Cache-first, 7일 TTL
  if (
    url.hostname === 'wsrv.nl' ||
    /\.(jpg|jpeg|png|webp|gif|svg)(\?|$)/i.test(url.pathname)
  ) {
    event.respondWith(cacheFirst(request, CACHE_NAMES.images, 7));
    return;
  }

  // 외부 API (Apps Script fallback 등) — SW 개입 안 함
  if (url.hostname !== location.hostname) {
    return;
  }

  // 나머지 (HTML, JS, CSS, manifest 등) — Stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request, CACHE_NAMES.static, 1));
});

// ─────────────────────────────────────────────
//  전략 함수
// ─────────────────────────────────────────────

/**
 * Network-first
 * 네트워크 성공 → 캐시 저장 후 반환
 * 네트워크 실패 → 캐시 반환 (없으면 에러)
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());  // 비동기로 저장
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      console.log('[SW] 오프라인 — 캐시 반환:', request.url);
      return cached;
    }
    // 캐시도 없으면 오프라인 페이지 또는 에러
    return new Response(
      JSON.stringify({ events: [], _sw_offline: true }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Cache-first
 * 캐시 히트 → 즉시 반환 (TTL 체크 포함)
 * 캐시 미스 or TTL 초과 → 네트워크 요청 후 캐시 갱신
 * @param {number} ttlDays 캐시 유효 기간 (일)
 */
async function cacheFirst(request, cacheName, ttlDays = 7) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  if (cached) {
    const cachedDate = new Date(cached.headers.get('sw-cached-at') || 0);
    const age = (Date.now() - cachedDate.getTime()) / 86400000;  // 일 단위
    if (age < ttlDays) {
      return cached;
    }
    // TTL 초과 — 캐시 삭제 후 재요청
    cache.delete(request);
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      // sw-cached-at 헤더를 추가해서 TTL 추적
      const headers = new Headers(response.headers);
      headers.set('sw-cached-at', new Date().toISOString());
      const stamped = new Response(await response.blob(), {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      cache.put(request, stamped);
      return stamped.clone();
    }
    return response;
  } catch (err) {
    console.warn('[SW] 이미지 fetch 실패:', request.url, err);
    // 만료된 캐시라도 반환
    return cached || new Response(null, { status: 503 });
  }
}

/**
 * Stale-while-revalidate
 * 캐시 있으면 즉시 반환 + 백그라운드에서 갱신
 * 캐시 없으면 네트워크 대기
 * @param {number} ttlDays TTL 초과 시 네트워크 응답까지 대기
 */
async function staleWhileRevalidate(request, cacheName, ttlDays = 1) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const fetchAndUpdate = async () => {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const headers = new Headers(response.headers);
        headers.set('sw-cached-at', new Date().toISOString());
        const stamped = new Response(await response.blob(), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        cache.put(request, stamped);
        return stamped.clone();
      }
      return response;
    } catch (err) {
      return null;
    }
  };

  if (cached) {
    const cachedDate = new Date(cached.headers.get('sw-cached-at') || 0);
    const age = (Date.now() - cachedDate.getTime()) / 86400000;

    if (age < ttlDays) {
      // 신선한 캐시 — 백그라운드에서만 갱신
      fetchAndUpdate();
      return cached;
    }
    // TTL 초과 — 갱신 결과를 기다렸다가 반환
    const fresh = await fetchAndUpdate();
    return fresh || cached;
  }

  // 캐시 없음 — 네트워크 대기
  const result = await fetchAndUpdate();
  return result || new Response(null, { status: 503 });
}

// ─────────────────────────────────────────────
//  메시지 핸들러 (앱에서 강제 갱신 요청 가능)
// ─────────────────────────────────────────────
self.addEventListener('message', event => {
  // 앱에서 navigator.serviceWorker.controller.postMessage({ type: 'SKIP_WAITING' })
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  // 앱에서 events.json 강제 갱신 요청
  // navigator.serviceWorker.controller.postMessage({ type: 'PURGE_EVENTS' })
  if (event.data?.type === 'PURGE_EVENTS') {
    caches.open(CACHE_NAMES.events)
      .then(cache => cache.delete('https://cultureondo.com/events.json'))
      .then(() => console.log('[SW] events.json 캐시 삭제 완료'));
  }
});
