import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PORT ?? 4411);
// localhost, not 127.0.0.1: passkeys need a host name for their RP ID.
const baseURL = `http://localhost:${port}`;

// Test-only values. Production has the real AUTH_PEPPER and TOTP_ENCRYPTION_KEY as Worker secrets and never DEV_MAILBOX.
const vars = [
  'DEV_MAILBOX:1',
  'AUTH_PEPPER:playwright-only-pepper',
  `TOTP_ENCRYPTION_KEY:${Buffer.from('test-only-totp-key-32-bytes-long').toString('base64')}`,
]
  .map((value) => `--var ${value}`)
  .join(' ');

export default defineConfig({
  testDir: 'tests',
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    // wrangler dev runs the Worker, _redirects, and the 404 page as Cloudflare does. Build first.
    // The local D1 database gets the migrations first. --infer-origin-from-routes=false keeps request.url on
    // localhost, which turns on the dev mailbox and the localhost origin check.
    command: `CI=1 npx wrangler d1 migrations apply pi-rust-accounts --local && npx wrangler dev --ip 127.0.0.1 --port ${port} --infer-origin-from-routes=false ${vars}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
