// 최소 서비스워커 — PWA 설치 가능하게 하는 용도 (네트워크 통과)
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', (e) => { /* 네트워크 그대로 사용 (부스는 항상 서버 필요) */ });
