'use strict';
// Fake data for screenshots / trying the UI without a GitHub account. Start with LGTM_DEMO=1.
const DEMO = (() => {
  const av = (c, ch) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44"><rect width="44" height="44" fill="${c}"/><text x="22" y="29" font-size="20" font-family="sans-serif" fill="#fff" text-anchor="middle">${ch}</text></svg>`);
  const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  const lab = (n, c) => ({ name: n, color: c });
  const mk = (i, repo, number, title, body, by, color, h, a, d, files, rd, ci, labels = [], draft = false, comments = 0, merge = 'BLOCKED', auto = false) => ({
    mergeStateStatus: merge, mergeable: merge === 'DIRTY' ? 'CONFLICTING' : 'MERGEABLE', autoMergeRequest: auto ? { enabledAt: ago(1) } : null,
    id: 'demo' + i, number, title, bodyText: body, url: `https://github.com/${repo}/pull/${number}`, isDraft: draft,
    createdAt: ago(h + 20), updatedAt: ago(h), additions: a, deletions: d, changedFiles: files, reviewDecision: rd,
    author: { login: by, avatarUrl: av(color, by[0].toUpperCase()) }, repository: { nameWithOwner: repo },
    labels: { nodes: labels }, comments: { totalCount: comments }, commits: { nodes: [{ commit: { statusCheckRollup: ci ? { state: ci } : null } }] },
  });
  const prs = [
    mk(1, 'acme/api', 1284, 'Add token-bucket rate limiting to the public API', 'Introduces a per-key token bucket limiter and wires it into the HTTP middleware. Limits are configurable in default.yaml.', 'maria', '#8250df', 2, 412, 38, 8, 'REVIEW_REQUIRED', 'SUCCESS', [lab('feature', '1f6feb'), lab('api', '2da44e')], false, 6),
    mk(2, 'acme/web', 3391, 'Fix flicker when switching workspaces', 'The sidebar remounted on every workspace change which caused a visible flicker. Memoize the tree.', 'tomas', '#cf222e', 5, 64, 21, 4, 'APPROVED', 'SUCCESS', [lab('bug', 'd73a4a')], false, 3, 'CLEAN'),
    mk(3, 'acme/web', 3388, 'Migrate settings page to the new design system', 'Large visual refactor of the settings screens.', 'aiko', '#0969da', 9, 1203, 887, 41, 'CHANGES_REQUESTED', 'FAILURE', [lab('design', 'a371f7'), lab('large', 'fbca04')], false, 14, 'DIRTY'),
    mk(4, 'acme/infra', 512, 'Bump Postgres to 16.4 and enable pg_stat_statements', 'Rolling upgrade plan in the description of the runbook.', 'dev-ops-bot', '#57606a', 12, 28, 9, 3, 'REVIEW_REQUIRED', 'PENDING', [lab('infra', '0e8a16')], false, 1, 'BEHIND'),
    mk(5, 'acme/mobile', 977, 'WIP: offline mode for the inbox', 'Early draft. Do not review yet.', 'sam', '#bf8700', 27, 540, 12, 17, null, null, [lab('wip', 'cfd3d7')], true, 0),
    mk(6, 'acme/api', 1279, 'Return 409 instead of 500 on duplicate idempotency keys', 'Fixes #1250.', 'priya', '#1a7f37', 30, 47, 6, 3, 'APPROVED', 'SUCCESS', [lab('bug', 'd73a4a')], false, 2, 'CLEAN', true),
    mk(7, 'acme/web', 3377, 'Add keyboard shortcuts cheatsheet', 'Press ? anywhere to open it.', 'lena', '#d1242f', 51, 188, 4, 6, 'REVIEW_REQUIRED', 'SUCCESS', [lab('feature', '1f6feb')], false, 5, 'BEHIND'),
    mk(8, 'acme/api', 1271, 'Upgrade grpc-go and regenerate protobufs', 'Mechanical upgrade, mostly generated files.', 'maria', '#8250df', 74, 2310, 1980, 63, 'REVIEW_REQUIRED', 'SUCCESS', [lab('deps', '0366d6')], false, 0, 'CLEAN'),
    mk(9, 'acme/infra', 505, 'Terraform: move staging VPC into its own state', 'Needs a careful `terraform state mv`.', 'tomas', '#cf222e', 96, 120, 95, 11, 'REVIEW_REQUIRED', null, [lab('infra', '0e8a16')], false, 8),
  ];
  const F = (filename, status, patch, extra = {}) => {
    const l = patch.split('\n'); return { filename, status, patch, additions: l.filter((x) => x[0] === '+').length, deletions: l.filter((x) => x[0] === '-').length, changes: l.length, ...extra };
  };
  const files = () => [
    F('internal/ratelimit/limiter.go', 'added', `@@ -0,0 +1,58 @@
+package ratelimit
+
+import (
+	"sync"
+	"time"
+)
+
+// Limiter is a per-key token bucket.
+type Limiter struct {
+	mu      sync.Mutex
+	rate    float64 // tokens added per second
+	burst   float64
+	buckets map[string]*bucket
+}
+
+type bucket struct {
+	tokens float64
+	last   time.Time
+}
+
+// New returns a Limiter that refills rate tokens per second up to burst.
+func New(rate float64, burst int) *Limiter {
+	return &Limiter{rate: rate, burst: float64(burst), buckets: map[string]*bucket{}}
+}
+
+// Allow reports whether a request for key may proceed right now.
+func (l *Limiter) Allow(key string) bool {
+	l.mu.Lock()
+	defer l.mu.Unlock()
+
+	now := time.Now()
+	b, ok := l.buckets[key]
+	if !ok {
+		b = &bucket{tokens: l.burst, last: now}
+		l.buckets[key] = b
+	}
+	elapsed := now.Sub(b.last).Seconds()
+	b.tokens = min(l.burst, b.tokens+elapsed*l.rate)
+	b.last = now
+	if b.tokens < 1 {
+		return false
+	}
+	b.tokens--
+	return true
+}`),
    F('internal/server/middleware.go', 'modified', `@@ -1,9 +1,12 @@
 package server
 
 import (
+	"net"
 	"net/http"
 	"time"
+
+	"acme.dev/api/internal/ratelimit"
 )
 
 func Logging(next http.Handler) http.Handler {
@@ -24,3 +27,22 @@ func Logging(next http.Handler) http.Handler {
 		next.ServeHTTP(w, r)
 	})
 }
+
+// RateLimit rejects requests that exceed the per-key budget with a 429.
+func RateLimit(l *ratelimit.Limiter) func(http.Handler) http.Handler {
+	return func(next http.Handler) http.Handler {
+		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+			key := r.Header.Get("X-Api-Key")
+			if key == "" {
+				key, _, _ = net.SplitHostPort(r.RemoteAddr)
+			}
+			if !l.Allow(key) {
+				w.Header().Set("Retry-After", "1")
+				http.Error(w, "rate limit exceeded", http.StatusTooManyRequests)
+				return
+			}
+			next.ServeHTTP(w, r)
+		})
+	}
+}`),
    F('internal/server/routes.go', 'modified', `@@ -14,8 +14,10 @@ import (
 func (s *Server) routes() http.Handler {
 	mux := http.NewServeMux()
 	mux.HandleFunc("/v1/orders", s.handleOrders)
-	mux.HandleFunc("/v1/users", s.handleUsers)
+	mux.HandleFunc("/v1/users", s.handleUsers)
+	mux.HandleFunc("/v1/usage", s.handleUsage)
 
-	return Logging(mux)
+	limiter := ratelimit.New(s.cfg.RateLimit.PerSecond, s.cfg.RateLimit.Burst)
+	return Logging(RateLimit(limiter)(mux))
 }`),
    F('internal/ratelimit/limiter_test.go', 'added', `@@ -0,0 +1,22 @@
+package ratelimit
+
+import "testing"
+
+func TestAllowBurstThenBlock(t *testing.T) {
+	l := New(1, 3)
+	for i := 0; i < 3; i++ {
+		if !l.Allow("k") {
+			t.Fatalf("request %d should be allowed", i)
+		}
+	}
+	if l.Allow("k") {
+		t.Fatal("4th request should be blocked")
+	}
+}
+
+func TestKeysAreIndependent(t *testing.T) {
+	l := New(1, 1)
+	l.Allow("a")
+	if !l.Allow("b") {
+		t.Fatal("key b must have its own bucket")
+	}
+}`),
    F('config/default.yaml', 'modified', `@@ -3,3 +3,7 @@ server:
   addr: ":8080"
   read_timeout: 5s
+rate_limit:
+  per_second: 20
+  burst: 40
 database:`),
    F('docs/rate-limits.md', 'added', `@@ -0,0 +1,8 @@
+# Rate limits
+
+Requests are limited per API key (or per IP when no key is sent).
+
+- **Sustained rate:** 20 requests / second
+- **Burst:** 40 requests
+
+When exceeded the API answers \`429\` with a \`Retry-After\` header.`),
    F('go.mod', 'modified', `@@ -3,4 +3,5 @@ module acme.dev/api
 go 1.22
 
 require (
+	golang.org/x/time v0.5.0
 	github.com/lib/pq v1.10.9`),
    F('go.sum', 'modified', `@@ -1,2 +1,4 @@
+golang.org/x/time v0.5.0 h1:o7cqy6amK/52YcAKIPlM3a+Fpj35zvRj2TP+e1xFSfk=
+golang.org/x/time v0.5.0/go.mod h1:3BpzKBy/shNhVucY/MWOyx10tF3SFh9QdLuxbVysPQM=
 github.com/lib/pq v1.10.9 h1:YXG7RB+JIjhP29X+OtkiDnYaXQwpS4JEWq7dtCCRUEw=`),
  ];
  const viewed = new Set(['go.sum']);
  return { prs, files: () => files().map((f) => ({ ...f, viewed: viewed.has(f.filename), stale: false })) };
})();
