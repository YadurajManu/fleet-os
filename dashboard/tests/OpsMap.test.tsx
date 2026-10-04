import { test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import OpsMap, { countryName } from '../src/components/OpsMap.js'

test('real country map supports keyboard buttons, zoom reset and unknown locations', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let selection = ''
  await act(async () => root.render(<OpsMap geography={[{country:'IN',users:4},{country:'unknown',users:2}]} selected="" onSelect={(country) => {selection=country}}/>))
  assert.ok(host.querySelectorAll('svg path').length > 150, 'renders real country boundaries')
  assert.ok(host.textContent?.includes('Unknown location'))
  const buttons = [...host.querySelectorAll('button')]
  await act(async () => buttons.find((button) => button.textContent?.includes('India'))!.click())
  assert.equal(selection, 'IN')
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click())
  assert.ok(host.textContent?.includes('1.5×'))
  await act(async () => buttons.find((button) => button.textContent==='Reset')!.click())
  assert.ok(host.textContent?.includes('1.0×'))
  assert.equal(countryName('unknown'), 'Unknown location')
  await act(async () => root.unmount())
  host.remove()
})
