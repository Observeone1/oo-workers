# UI e2e conventions

The Playwright suite under `tests/ui/` follows one rule above all:

> **Tests locate elements by `data-testid`, never by CSS class or DOM
> structure.** Visual redesigns must not break the test suite.

This rule exists because PR #45 (the v2 dashboard redesign) silently
broke ~24 tests in one commit by rewriting class names, page wrappers,
and form structures — without weakening any actual capability. Tests
that anchor on visual selectors are a tax on every redesign; tests
that anchor on `data-testid` are immune.

## Authoring a new test

```ts
import { test, expect } from './fixtures';

test('user can create a webhook channel', async ({ page }) => {
  await page.goto('/#/channels');
  await page.getByTestId('channels-add-btn').click();
  await page.getByTestId('channel-name-input').fill('PagerDuty');
  await page.getByTestId('channel-url-input').fill('https://…');
  await page.getByTestId('channel-create-submit').click();
  await expect(page.getByTestId(`channel-card-PagerDuty`)).toBeVisible();
});
```

If the element you need to click or assert on doesn't have a
`data-testid` yet, **add one in the same change** — don't reach for
CSS classes as a shortcut.

## Naming

`data-testid="<area>-<element>"` — kebab-case, area-scoped:

| Area              | Examples                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| Header / nav      | `brand`, `nav-monitors`, `nav-channels`, `nav-settings-btn`, `nav-sign-out` |
| Monitor list      | `monitors-search-input`, `monitors-tab-url`, `monitors-row-{name}`        |
| Add-monitor dlg   | `add-monitor-btn`, `add-monitor-dialog`, `add-monitor-type-tile-url`,     |
|                   | `add-monitor-name-input`, `add-monitor-url-input`,                        |
|                   | `add-monitor-interval-input`, `add-monitor-api-method`,                   |
|                   | `add-monitor-qa-script`, `add-monitor-api-assertions`,                    |
|                   | `add-monitor-api-add-assertion`, `add-monitor-api-assertion-row`,         |
|                   | `add-monitor-api-assertion-{type,operator,path,value,remove}`,            |
|                   | `add-monitor-submit`                                                      |
| Channels          | `channels-add-btn`, `channel-card-{name}`, `channel-test-btn`             |
| Regions           | `regions-add-btn`, `region-card-{slug}`, `region-rotate-btn`              |
| Status pages      | `sp-add-btn`, `sp-item-{slug}`, `sp-public-link`                          |
| Incidents         | `incidents-create-btn`, `incident-card-{title}`                           |
| Settings          | `settings-tab-profile`, `settings-tab-keys`, `settings-tab-backup`,       |
|                   | `s-backup-download`                                                       |
| Slideover         | `slideover`, `slideover-primary`, `slideover-cancel`                      |
| Confirm dialog    | `confirm-dialog`, `confirm-ok`, `confirm-cancel`                          |
| Banners / status  | `banner-ok`, `banner-err`                                                 |
| Page-level        | `page-title` (the route's `<h2>`)                                         |

Where the name is dynamic (a card for a specific channel/region/etc.),
interpolate the entity name or slug after the area prefix. Use the
exact same string the user sees in the UI so tests read naturally.

## When NOT to add a testid

- **Inputs identified by `name="…"`.** Forms with `<input name="email">`
  already have a stable contract. Use `page.locator('input[name="email"]')`
  if you need to scope inside a specific form/section.
- **Generic structural assertions.** "There's at least one `<tr>` in the
  table" doesn't need a testid — it's not about a specific element.
- **Decorative SVGs, dividers, hidden inputs.** Don't litter the markup.

## Stable attributes still allowed (legacy, not added new)

A few existing attributes are stable contracts and not migrated to
testids: `data-tab`, `data-route`, `data-clear-search`, `data-channel-id`,
`data-region-id`, `data-page-prev/next`, `data-open` on monitor rows.
These were intentional selectors before the testid policy and aren't
churning. New tests should still prefer `data-testid`.

## Enforcement

Anyone touching `src/ui/` should also touch `tests/ui/` if they renamed
a tested element — and vice versa. The static gates don't catch
selector drift, so the discipline is in code review + this doc.

See also the realignment PR that established this policy (PR after #46).
