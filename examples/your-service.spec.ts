// Sample browser check for a self-hosted service.
//
// Replace BASE_URL with your own app. This script demonstrates a realistic
// e2e flow — load page, check title, verify a key element, optionally log in.
// Paste it into the "+ Add monitor" → Browser dialog in the oo-workers UI,
// or include it in a bulk-import JSON under `qa_projects[].tests[].script`.

import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL ?? 'https://your-service.example.com';

test('homepage loads and shows expected content', async ({ page }) => {
  await page.goto(BASE_URL);
  await expect(page).toHaveTitle(/your service/i);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('health endpoint returns 200', async ({ request }) => {
  const response = await request.get(`${BASE_URL}/health`);
  expect(response.status()).toBe(200);
});

// Uncomment + adapt for an authenticated flow:
//
// test('user can log in', async ({ page }) => {
//   await page.goto(`${BASE_URL}/login`);
//   await page.getByLabel('Email').fill(process.env.LOGIN_EMAIL ?? '');
//   await page.getByLabel('Password').fill(process.env.LOGIN_PASSWORD ?? '');
//   await page.getByRole('button', { name: /sign in/i }).click();
//   await expect(page.getByText(/welcome/i)).toBeVisible();
// });
