// Browser verification uses network fixtures only; no production mock flag or data is shipped.
import { mkdir, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const output = new URL('../../notes/screenshots/', import.meta.url)
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
const checks = []
const definitions = [['api','Control plane API','Core'],['postgres','Postgres','Core'],['redis','Redis','Core'],['registry','Registry storage','Core'],['ingress','Ingress (Caddy)','Platform'],['tunnel','Tunnel gateway','Platform'],['build','Build pipeline','Platform'],['scheduler','Scheduler','Platform'],['logs','Log streaming','Platform'],['github-app','GitHub App & webhooks','Integrations'],['cli-auth','CLI authentication','Integrations'],['website','Website','Web'],['docs','Docs','Web'],['dashboard','Dashboard','Web']]
const scenarios = ['operational','expanded','degraded','major_outage','maintenance','unknown','stale','history_incident','history_empty']
try {
  for (const width of [1440,390]) for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: { width,height:1000 }, reducedMotion:'reduce' })
    const page = await context.newPage()
    const problems = []; page.on('pageerror', error => problems.push(error.message))
    const now = Date.now(); const since = new Date(now - 10*86400000).toISOString()
    const ticks = Array.from({ length:10 },(_,i) => ({ start:new Date(now - (9-i)*86400000).toISOString(),status:'operational',uptime:100,checks:2880,incidents:[] }))
    const level = ['degraded','major_outage','maintenance','unknown'].includes(scenario) ? scenario : 'operational'
    const snapshot = { status:level,stale:scenario === 'stale',as_of:new Date(now).toISOString(),monitoring_since:since,components:definitions.map(([slug,name,group],i) => ({ slug,name,group,status:scenario === 'unknown' ? 'unknown' : i === 0 ? level : 'operational',description:`Independent health monitoring for ${name}.`,checked_at:new Date(now).toISOString(),monitoring_since:since,uptime:100,checks:28800,ticks })),incidents:scenario === 'history_incident' ? [{ id:'test-incident',title:'Control plane API health interruption',impact:'major_outage',status:'resolved',started_at:new Date(now-86400000).toISOString(),resolved_at:new Date(now-86000000).toISOString(),components:['api'] }] : [],maintenance:[] }
    await page.route('**/v1/status**', async route => {
      if (route.request().url().includes('/stream')) return route.abort()
      if (route.request().url().includes('/uptime')) return route.fulfill({ json:{ ticks,monitoring_since:since,coverage:.75,uptime:100,checks:28800,granularity:'day' } })
      return route.fulfill({ json:snapshot })
    })
    await page.route('https://api.github.com/**',route => route.fulfill({ json:{ stargazers_count:12 } }))
    await page.goto(process.env.STATUS_VISUAL_URL ?? 'http://127.0.0.1:4173/status')
    await page.getByRole('heading',{ name:'Service status',exact:true }).waitFor()
    await page.getByRole('button',{ name:/Control plane API/ }).waitFor()
    if (scenario === 'expanded') {
      const button = page.getByRole('button',{ name:/Control plane API/ }); await button.focus(); await page.keyboard.press('Enter'); await assert.equal(await button.getAttribute('aria-expanded'),'true')
      await page.getByRole('button',{ name:'90d',exact:true }).waitFor()
      const range = page.getByRole('button',{ name:'7d',exact:true }); await range.focus(); await page.keyboard.press('Enter'); assert.equal(await range.getAttribute('aria-pressed'),'true')
      const tick = page.locator('.status-tick-bar [tabindex="0"]').first(); await tick.waitFor(); await tick.focus(); assert.ok(await tick.getAttribute('aria-label'))
    }
    if (scenario.startsWith('history')) { const tab = page.getByRole('tab',{ name:'History',exact:true }); await tab.focus(); await page.keyboard.press('Enter'); assert.equal(await tab.getAttribute('aria-selected'),'true') }
    await page.waitForTimeout(300)
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)
    assert.equal(overflow,false,`${scenario} ${width}: horizontal overflow`)
    const boxes = await page.locator('.status-component-top').evaluateAll(rows => rows.map(row => {
      const labels = [...row.querySelectorAll('.status-component-name,.status-info,.status-component-uptime')].map(e => e.getBoundingClientRect())
      return labels.some((a,i) => labels.slice(i+1).some(b => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top))
    }))
    assert.equal(boxes.some(Boolean),false,`${scenario} ${width}: overlapping component labels`)
    // Verify hit testing after scrolling each footer link into view.
    const links = page.locator('footer a:visible')
    for (let i=0;i<await links.count();i++) { const link = links.nth(i); await link.scrollIntoViewIfNeeded(); const reachable = await link.evaluate(el => { const r=el.getBoundingClientRect(); const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2); return hit === el || el.contains(hit) }); assert.ok(reachable,`Footer link blocked: ${await link.textContent()}`) }
    await page.evaluate(() => window.scrollTo(0,0)); await page.waitForTimeout(1400)
    await page.screenshot({ path:fileURLToPath(new URL(`${width}-${scenario}.png`,output)),fullPage:true })
    assert.deepEqual(problems,[])
    checks.push({ width,scenario,horizontalOverflow:false,componentLabelOverlap:false,footerLinksClickable:true,pageErrors:problems })
    await context.close()
  }
  await writeFile(new URL('verification.json',output),JSON.stringify(checks,null,2)+'\n')
  console.log(`PASS: ${checks.length} screenshot states, overflow, label overlap, keyboard controls and footer hit testing.`)
} finally { await browser.close() }
