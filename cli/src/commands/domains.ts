import { request, requireFleet, CliError, EXIT } from '../api.js'
import { c } from '../render.js'
import type { Flags } from '../args.js'

type Service = { id: string; name: string; project: string }
type Domain = { id: string; host: string; kind: string; source: string; challenge: string | null; verifiedAt: string | null; primary: boolean; status: string }
type DomainList = { managed: string | null; primary: string | null; target: string; targetAddresses: string[]; domains: Domain[] }

async function selected(name: string, flags: Flags): Promise<Service> {
  const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
  const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
  const matches = body.services.filter((s) => s.id === name || (s.name === name && (!flags.project || s.project === flags.project)))
  if (matches.length !== 1) throw new CliError(matches.length ? `Several services are named ${name}; pass --project <name>.` : `No service named ${name}. Run fleet services.`, EXIT.usage)
  return matches[0]!
}

const list = async (service: Service) => (await request<DomainList>('GET', `/services/${service.id}/domains`)).body

export const domainsCommand = {
  async run(args: string[], flags: Flags) {
    const [verb, name, host] = args
    if (!verb || !['add', 'check', 'primary', 'rm'].includes(verb)) {
      const fleetId = await requireFleet(typeof flags.fleet === 'string' ? flags.fleet : undefined)
      const { body } = await request<{ services: Service[] }>('GET', `/fleets/${fleetId}/services`)
      const matches = verb ? body.services.filter((s) => s.name === verb || s.id === verb) : body.services
      if (verb && !matches.length) throw new CliError(`No service named ${verb}.`, EXIT.usage)
      for (const service of matches) {
        const data = await list(service)
        if (flags.json) console.log(JSON.stringify({ service: service.name, project: service.project, ...data }))
        else {
          console.log(`${c.bold(`${service.project}/${service.name}`)}  ${data.primary ?? 'internal'}`)
          for (const domain of data.domains) console.log(`  ${domain.host} · ${domain.status}${domain.primary ? ' · primary' : ''}`)
        }
      }
      return
    }
    if (!name) throw new CliError(`Use fleet domains ${verb} <service>${verb === 'check' ? ' [host]' : ' <host>'}`, EXIT.usage)
    const service = await selected(name, flags)
    const path = `/services/${service.id}/domains`
    if (verb === 'add') {
      if (!host) throw new CliError('Enter a Fleet name or domain: fleet domains add <service> <host>', EXIT.usage)
      const { body } = await request<{ domain: Domain; dns: { ownership: { name: string; value: string }; routing: { name: string; cname: string; addresses: string[] } } | null }>('POST', path, { body: { host } })
      if (flags.json) return void console.log(JSON.stringify(body))
      console.log(`${c.bold(body.domain.host)} added${body.dns ? ' · waiting for DNS' : ' · attached'}`)
      if (body.dns) console.log(`  TXT     ${body.dns.ownership.name} = ${body.dns.ownership.value}\n  CNAME   ${body.dns.routing.name} → ${body.dns.routing.cname} (subdomain)\n  A       ${body.dns.routing.addresses.join(', ') || 'resolve the ingress IP'} (apex)\n  Set DNS-only / proxy off, then run: fleet domains check ${name} ${body.domain.host}`)
      else console.log(`  Make primary: fleet domains primary ${name} ${body.domain.host}`)
      return
    }
    const data = await list(service)
    const found = host ? data.domains.filter((d) => d.host === host.toLowerCase()) : data.domains
    if (host && !found.length && !(verb === 'primary' && host.toLowerCase() === data.managed))
      throw new CliError(`${host} is not attached to ${name}.`, EXIT.usage)
    if (verb === 'check') {
      for (const domain of found) {
        const { body } = await request<{ ownership: boolean; routing: boolean; observedA?: string[]; status: string }>('POST', `${path}/${domain.id}/check`)
        if (flags.json) console.log(JSON.stringify({ host: domain.host, ...body }))
        else console.log(`${domain.host}  ${body.status.replaceAll('_', ' ')}${body.routing ? '' : ` · DNS points to ${body.observedA?.join(', ') || 'nothing'}, expected ${data.target}`}`)
      }
      return
    }
    if (!host) throw new CliError(`Use fleet domains ${verb} <service> <host>`, EXIT.usage)
    if (verb === 'primary' && host.toLowerCase() === data.managed) {
      const { body } = await request<{ primary: string }>('POST', `${path}/managed/primary`)
      if (flags.json) console.log(JSON.stringify(body))
      else console.log(`${c.bold(body.primary)} is now the primary URL.`)
      return
    }
    if (found.length !== 1) throw new CliError(`Use fleet domains ${verb} <service> <host>`, EXIT.usage)
    const domain = found[0]!
    if (verb === 'primary') {
      const { body } = await request<{ primary: string }>('POST', `${path}/${domain.id}/primary`)
      if (flags.json) console.log(JSON.stringify(body))
      else console.log(`${c.bold(body.primary)} is now the primary URL. The permanent Fleet URL still works.`)
      return
    }
    const { body } = await request<{ removed: string; primary: string | null }>('DELETE', `${path}/${domain.id}`)
    if (flags.json) console.log(JSON.stringify(body))
    else console.log(`${body.removed} removed. Primary URL: ${body.primary ?? 'none'}`)
  },
}
