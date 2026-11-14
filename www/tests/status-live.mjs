import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const dir = new URL('../../notes/screenshots/',import.meta.url); await mkdir(dir,{ recursive:true })
const browser = await chromium.launch({ headless:true,...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) })
const results = []
try {
  for (const width of [1440,390]) {
    const page = await browser.newPage({ viewport:{ width,height:1000 },reducedMotion:'reduce' })
    await page.goto('http://127.0.0.1:4173/status')
    const snapshotResponse = await page.request.get('http://localhost:8080/v1/status'); assert.equal(snapshotResponse.status(),200)
    const snapshot = await snapshotResponse.json(); assert.ok(snapshot.components.length)
    for (const component of snapshot.components) await page.getByRole('button',{ name:new RegExp(component.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')) }).waitFor()
    const first = snapshot.components[0]
    const historyResponse = page.waitForResponse(async res => { if (!res.url().includes(`/components/${first.slug}/uptime?range=`)) return false; try { return res.status() === 200 && Array.isArray((await res.json()).ticks) } catch { return false } })
    await page.getByRole('button',{ name:new RegExp(first.name) }).click()
    const history = await historyResponse; assert.equal(history.status(),200); assert.ok(Array.isArray((await history.json()).ticks))
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),false)
    const headerLabels = await page.locator('header a:has(svg),header button').evaluateAll(elements => elements.map(e => ({ text:e.textContent.trim(),aria:e.getAttribute('aria-label'),title:e.getAttribute('title') })).filter(e => !e.text))
    assert.ok(headerLabels.every(e => e.aria))
    await page.locator('footer').scrollIntoViewIfNeeded(); await page.waitForTimeout(1400); await page.evaluate(() => scrollTo(0,0)); await page.waitForTimeout(300)
    await page.screenshot({ path:fileURLToPath(new URL(`live-api-${width}.png`,dir)),fullPage:true })
    results.push({ width,status:snapshot.status,components:snapshot.components.map(c => c.slug),snapshotHTTP:200,uptimeHTTP:200,headerLabels,networkFixtures:false })
    await page.close()
  }
  await writeFile(new URL('live-api-verification.json',dir),JSON.stringify(results,null,2)+'\n'); console.log(JSON.stringify(results,null,2))
} finally { await browser.close() }
