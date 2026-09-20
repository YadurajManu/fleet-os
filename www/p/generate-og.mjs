// Pairing installer: https://fleetapi.plastikworld.xyz/install.sh
import { writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
await mkdir(dist, { recursive: true })
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#08090b"/><g font-family="sans-serif"><text x="80" y="130" fill="#3fe08b" font-size="32">FLEET OS</text><text x="80" y="285" fill="#eeeeee" font-size="62">Deploy to hardware</text><text x="80" y="365" fill="#eeeeee" font-size="62">you already own.</text><text x="80" y="505" fill="#b0b8c0" font-size="28">Open source · Self-hosted · Your hardware</text><text x="80" y="565" fill="#b0b8c0" font-size="22">fleet.plastikworld.xyz</text></g></svg>`
await writeFile(`${dist}/og.svg`, svg)
await sharp(Buffer.from(svg)).png().toFile(`${dist}/og.png`)
console.log('Generated deterministic 1200×630 share card in dist')
