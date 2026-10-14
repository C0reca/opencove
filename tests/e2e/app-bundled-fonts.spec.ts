import { expect, test } from '@playwright/test'
import { launchApp } from './workspace-canvas.helpers'

test.describe('Bundled interface font', () => {
  test('renders interface text with the bundled Inter faces', async () => {
    const { electronApp, window } = await launchApp()

    try {
      await window.waitForLoadState('domcontentloaded')
      await expect(window.locator('body')).toBeVisible()

      // FontFace entries exist only for @font-face rules, so a loaded entry proves the bundled file
      // loaded; a system-installed Inter would not appear here.
      await expect
        .poll(
          () =>
            window.evaluate(async () => {
              await document.fonts.ready
              return [...document.fonts]
                .filter(face => face.family.replace(/["']/g, '') === 'Inter')
                .map(face => `${face.weight}:${face.status}`)
            }),
          { timeout: 15_000 },
        )
        .toContain('400 700:loaded')

      const fontFamily = await window.evaluate(() => getComputedStyle(document.body).fontFamily)
      expect(fontFamily.replace(/["']/g, '').split(',')[0]?.trim()).toBe('Inter')

      await test.info().attach('bundled-inter-window', {
        body: await window.screenshot(),
        contentType: 'image/png',
      })
    } finally {
      await electronApp.close()
    }
  })
})
