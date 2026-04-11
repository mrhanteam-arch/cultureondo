// 컬처온도 Service Worker
var CACHE_NAME = 'cultureondo-v1';
var STATIC_CACHE = 'cultureondo-static-v1';
var DATA_CACHE = 'cultureondo-data-v1';

// 정적 파일 캐시 목록
var STATIC_FILES = [
  '/',
  '/index.html'
];

// 설치 — 정적 파일 캐시
self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(STATIC_CACHE).then(function(cache) {
      return cache.addAll(STATIC_FILES);
    })
  );
});

// 활성화 — 구버전 캐시 삭제
self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(key) {
          return key !== STATIC_CACHE && key !== DATA_CACHE;
        }).map(function(key) {
          return caches.delete(key);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// fetch 인터셉트
self.addEventListener('fetch', function(e) {
  var url = e.request.url;

  // events.json — Network First (최신 데이터 우선, 실패 시 캐시)
  if (url.includes('events.json')) {
    e.respondWith(
      fetch(e.request).then(function(res) {
        var clone = res.clone();
        caches.open(DATA_CACHE).then(function(cache) {
          cache.put(e.request, clone);
        });
        return res;
      }).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }

  // wsrv.nl 이미지 — Cache First (이미지는 캐시 우선)
  if (url.includes('wsrv.nl') || url.includes('kopis.or.kr')) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        if (cached) return cached;
        return fetch(e.request).then(function(res) {
          var clone = res.clone();
          caches.open(DATA_CACHE).then(function(cache) {
            cache.put(e.request, clone);
          });
          return res;
        });
      })
    );
    return;
  }

  // index.html — Network First
  if (url.includes('cultureondo.com') && !url.includes('.')) {
    e.respondWith(
      fetch(e.request).then(function(res) {
        var clone = res.clone();
        caches.open(STATIC_CACHE).then(function(cache) {
          cache.put(e.request, clone);
        });
        return res;
      }).catch(function() {
        return caches.match('/index.html');
      })
    );
    return;
  }

  // 나머지 — 기본 fetch
  e.respondWith(fetch(e.request).catch(function() {
    return caches.match(e.request);
  }));
});
