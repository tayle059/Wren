// Renders web/public/icon.svg to the PNG sizes phones need. Run once: npx tsx e2e/icons.mts
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const svg = readFileSync('web/public/icon.svg', 'utf8');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium' });
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: `web/public/icon-${size}.png`, omitBackground: true });
}
await browser.close();
