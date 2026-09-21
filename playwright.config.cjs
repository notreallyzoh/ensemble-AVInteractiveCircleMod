const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './tests/browser', timeout: 90000, workers: 1,
  use: { baseURL: process.env.TEST_URL || 'http://127.0.0.1:8091', headless: true, channel: 'chrome',
    viewport: { width: 1280, height: 960 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: process.env.TEST_URL ? undefined : { command: 'node server.js', port: 8091, reuseExistingServer: false, env: { PORT: '8091' } },
});
