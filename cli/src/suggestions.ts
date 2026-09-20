/**
 * Contextual error recovery suggestions.
 *
 * When an operation fails, printing the raw error message tells the user what
 * went wrong, but does not always tell them what to do next. This module pattern-matches
 * common failure conditions and returns clear, actionable recovery commands.
 */

export interface SuggestionRule {
  pattern: RegExp
  suggestions: string[]
}

export const RULES: SuggestionRule[] = [
  {
    pattern: /(?:port|address|bind).*(?:already in use|is taken|in use)|already in use/i,
    suggestions: [
      'run "fleet services" to identify conflicting services',
      'stop the conflicting service with "fleet down <service>"',
    ],
  },
  {
    pattern: /no eligible node|no matching node|insufficient resources/i,
    suggestions: [
      'check node status and resource availability with "fleet nodes"',
      'pair an additional node with "fleet nodes pair"',
    ],
  },
  {
    pattern: /image not found|manifest unknown|repository does not exist|pull access denied/i,
    suggestions: [
      'verify the container image name and tag in fleet.yaml',
      'ensure the target image registry is accessible and credentials are configured',
    ],
  },
  {
    pattern: /health check failed|healthcheck failed|container unhealthy/i,
    suggestions: [
      'inspect service logs with "fleet logs <service>"',
      'run "fleet explain <service>" for automated diagnosis',
    ],
  },
  {
    pattern: /ECONNREFUSED|Could not reach|failed to connect/i,
    suggestions: [
      'check if the Fleet control plane is running and accessible',
      'verify the configured API URL with "fleet config show"',
    ],
  },
  {
    pattern: /session.*(?:expired|invalid)|token expired|jwt expired/i,
    suggestions: [
      'refresh your login session with "fleet auth login"',
    ],
  },
  {
    pattern: /not signed in|authentication required|unauthorized|bearer token required/i,
    suggestions: [
      'sign in to the control plane with "fleet auth login --api <url>"',
    ],
  },
  {
    pattern: /fleet(?:.*not found|.*does not exist)|no fleets/i,
    suggestions: [
      'check your account and available fleets with "fleet auth whoami"',
      'select an active fleet with "fleet use <name>"',
    ],
  },
  {
    pattern: /Dockerfile.*not found|no Dockerfile/i,
    suggestions: [
      'run "fleet init" to detect your project stack and generate a Dockerfile',
    ],
  },
  {
    pattern: /disk.*full|no space left on device|out of disk space/i,
    suggestions: [
      'run "docker system prune" on the host node to reclaim disk space',
      'run "fleet doctor" to inspect disk health across nodes',
    ],
  },
  {
    pattern: /timed? ?out|ETIMEDOUT/i,
    suggestions: [
      'check network connectivity between the CLI, control plane, and nodes',
      'run "fleet doctor" to verify cluster connectivity',
    ],
  },
  {
    pattern: /permission denied|EACCES/i,
    suggestions: [
      'verify file and directory permissions in your project root',
      'ensure the current user has permission to interact with the Docker daemon',
    ],
  },
]

/**
 * Match an error message against known patterns and return up to 3 recovery suggestions.
 */
export function suggest(message: string, maxSuggestions = 3): string[] | null {
  if (!message) return null
  const suggestions: string[] = []

  for (const rule of RULES) {
    if (rule.pattern.test(message)) {
      for (const item of rule.suggestions) {
        if (!suggestions.includes(item)) {
          suggestions.push(item)
          if (suggestions.length >= maxSuggestions) break
        }
      }
    }
    if (suggestions.length >= maxSuggestions) break
  }

  return suggestions.length > 0 ? suggestions : null
}
