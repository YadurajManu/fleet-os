import { useEffect, useState } from 'react'

const CACHE_KEY = 'fleet_gh_stars'
const CACHE_TTL_MS = 10 * 60 * 1000 // 10 minutes
const REPO_URL = 'https://github.com/YadurajManu/fleet-os'
const API_URL = 'https://api.github.com/repos/YadurajManu/fleet-os'

function formatStars(num) {
  if (typeof num !== 'number' || isNaN(num)) return null
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  }
  return String(num)
}

export default function GitHubStarBadge({ className = '', compact = false }) {
  const [stars, setStars] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // 1. Try local cache first to prevent flash and stay within rate limits
    try {
      const cached = localStorage.getItem(CACHE_KEY)
      if (cached) {
        const { count, timestamp } = JSON.parse(cached)
        if (typeof count === 'number' && Date.now() - timestamp < CACHE_TTL_MS) {
          setStars(count)
          setLoading(false)
          return
        }
      }
    } catch {
      // localStorage unavailable or corrupt; ignore
    }

    // 2. Fetch fresh count from GitHub API
    const controller = new AbortController()
    fetch(API_URL, {
      signal: controller.signal,
      headers: { Accept: 'application/vnd.github.v3+json' },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data) => {
        if (typeof data.stargazers_count === 'number') {
          setStars(data.stargazers_count)
          try {
            localStorage.setItem(
              CACHE_KEY,
              JSON.stringify({
                count: data.stargazers_count,
                timestamp: Date.now(),
              })
            )
          } catch {
            // ignore localStorage quota errors
          }
        }
        setLoading(false)
      })
      .catch(() => {
        // Fallback: keep previous or set default without breaking
        setLoading(false)
      })

    return () => controller.abort()
  }, [])

  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Star YadurajManu/fleet-os on GitHub"
      className={`group inline-flex items-center gap-2 rounded-[3px] border border-[var(--color-line-2)] bg-[var(--color-ink-900)] px-2.5 py-[6px] font-mono text-[11.5px] text-[var(--color-fg)] transition-all duration-300 hover:border-[var(--color-signal)] hover:text-[var(--color-signal)] ${className}`}
    >
      {/* GitHub Octicon Star */}
      <svg
        width="13"
        height="13"
        viewBox="0 0 16 16"
        fill="currentColor"
        className="text-[var(--color-warn)] transition-transform duration-300 group-hover:scale-110"
        aria-hidden="true"
      >
        <path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z" />
      </svg>

      {!compact && <span className="font-medium">Star</span>}

      {/* Star Count with Skeleton Loader */}
      {loading ? (
        <span
          className="inline-block h-3.5 w-6 animate-pulse rounded bg-[var(--color-line-2)]"
          aria-hidden="true"
        />
      ) : (
        <span className="tabular-nums text-[var(--color-fg-muted)] transition-colors duration-300 group-hover:text-[var(--color-signal)]">
          {formatStars(stars) ?? '★'}
        </span>
      )}
    </a>
  )
}
