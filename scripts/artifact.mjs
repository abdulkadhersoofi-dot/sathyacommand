// Packs the production build into a single hosted page (claude.ai Artifact):
// the page fragment + inlined CSS, with app.js published alongside it.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'

const html = readFileSync('index.html', 'utf8')
const css = readFileSync('dist/style.css', 'utf8')
const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts[^>]+>/)[0]
const app = html.slice(html.indexOf('<!--APP-->') + 10, html.indexOf('<!--/APP-->'))

mkdirSync('dist-artifact', { recursive: true })
writeFileSync('dist-artifact/index.html', `<title>Sathya Command</title>
<meta name="claude:viewport-fit-sides" content="cover">
${fonts}
<style>${css}</style>
${app}
<script type="module" src="app.js"></script>
`)
copyFileSync('dist/app.js', 'dist-artifact/app.js')
console.log('dist-artifact/ ready')
