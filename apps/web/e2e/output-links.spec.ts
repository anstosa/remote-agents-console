import { expect, test, type Locator, type Page } from '@playwright/test';
import { outputLinkSegments, outputUrlMatchesHost } from '../src/output-links';

// verify output host matching
test('matches output URLs to the configured stack host', () => {
  expect(outputUrlMatchesHost('https://project.example.com/details?view=files', 'https://project.example.com')).toBe(true);
  expect(outputUrlMatchesHost('https://outside.example.com/details', 'https://project.example.com')).toBe(false);
  expect(outputUrlMatchesHost('not a URL', 'https://project.example.com')).toBe(false);
});

test('maps wrapped output links to visible terminal-cell overlays', () => {
  expect(outputLinkSegments(
    { start: { x: 78, y: 4 }, end: { x: 10, y: 5 } },
    80,
    24,
    0
  )).toEqual([
    { column: 77, row: 3, columns: 3 },
    { column: 0, row: 4, columns: 10 }
  ]);
});

test('clips output link overlays to the visible viewport', () => {
  expect(outputLinkSegments(
    { start: { x: 70, y: 8 }, end: { x: 12, y: 11 } },
    80,
    2,
    9
  )).toEqual([
    { column: 0, row: 0, columns: 80 },
    { column: 0, row: 1, columns: 12 }
  ]);
});

test('opens the complete target for links split across captured terminal rows', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async () => {
    const { renderCapturedWrappedOutputLink } = await import('/e2e/output-links-fixture.ts');
    await renderCapturedWrappedOutputLink(document.querySelector<HTMLElement>('#output-links')!);
  });
  const container = page.locator('#output-links');
  await expect(container).toHaveAttribute('data-ready', 'true');
  const uri = await container.getAttribute('data-uri');
  expect(uri).not.toBeNull();
  const links = page.locator('.output-link-overlay');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri!);
  await expect(links.last()).toHaveAttribute('href', uri!);
  const popupPromise = page.waitForEvent('popup');
  await links.last().click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(uri!);
  await popup.close();
});

// mount one captured link without leaving the deterministic fixture
const mountCapturedLink = async (page: Page, output: string, columns = 80) => {
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  // render the captured rows
  await page.evaluate(async ({ output, columns }) => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    const container = document.querySelector<HTMLElement>('#output-links');
    // require the mounted fixture
    if (container === null) throw new Error('output link fixture is unavailable');
    await renderOutputLinkText(container, output, columns);
  }, { output, columns });
};

// measure one overlay in terminal cells
const overlayCells = async (page: Page, link: Locator, columns = 80) => {
  const [linkBox, screenBox] = await Promise.all([
    link.boundingBox(),
    page.locator('#output-links .xterm-screen').boundingBox()
  ]);
  // require measured geometry
  if (linkBox === null || screenBox === null) throw new Error('output link geometry is unavailable');
  const cellWidth = screenBox.width / columns;
  return { column: (linkBox.x - screenBox.x) / cellWidth, columns: linkBox.width / cellWidth };
};

// preserve the reported protocol targets across captured UUID boundaries
for (const fixture of [
  { name: '96-well ELISA', optimizer: 'cb19a22a-15d5-4d55-83e4-6fc1a9bcb5af', trial: 'e70d6fd5-8ede-486a-9642-448ef47e6401', protocol: 'dffeab9f-c3d1-48c8-a1b0-5c7165af8b85', split: 19, indent: '', columns: 160 },
  { name: '384-well ELISA', optimizer: '39742947-b953-426a-992a-d06278030760', trial: 'a1fa85de-e9ef-415d-969a-a31073632b18', protocol: '7e0c6efd-3300-4fef-8bb3-26e466e8e302', split: 19, indent: '  ', columns: 160 },
  { name: 'Monomer1536 with native wrapping', optimizer: '889ea2fd-8dc3-496a-8528-68c8ba56bf71', trial: 'abad44dc-6180-4d3a-aac3-641b3af3a5c9', protocol: '0a7ce623-ed88-4325-b364-4fbb32fd0768', split: 19, indent: '  ', columns: 80 },
  { name: 'mid-hex UUID', optimizer: 'cb19a22a-15d5-4d55-83e4-6fc1a9bcb5af', trial: 'e70d6fd5-8ede-486a-9642-448ef47e6401', protocol: 'dffeab9f-c3d1-48c8-a1b0-5c7165af8b85', split: 21, indent: '  ', columns: 160 },
  { name: 'UUID continuation with native wrapping', optimizer: 'cb19a22a-15d5-4d55-83e4-6fc1a9bcb5af', trial: 'e70d6fd5-8ede-486a-9642-448ef47e6401', protocol: 'dffeab9f-c3d1-48c8-a1b0-5c7165af8b85', split: 3, indent: '  ', columns: 34 }
]) {
  // verify every physical segment and both navigation ends
  test(`opens the full captured UUID link for ${fixture.name}`, async ({ page }) => {
    const uri = `https://example.com/project/e9e7cc10-a174-49ed-95a2-5a011509c988/parameter/optimizer/${fixture.optimizer}/trial/${fixture.trial}/entity/protocol/${fixture.protocol}/execution?protocol-tab=plate_maps`;
    const cut = uri.indexOf(fixture.trial) + fixture.split;
    const first = `${fixture.indent}${uri.slice(0, cut)}`;
    const last = `${fixture.indent}${uri.slice(cut)}`;
    // keep navigation on a controlled destination
    await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>protocol fixture</main>' }));
    await mountCapturedLink(page, `${first}\r\n${last}`, fixture.columns);

    const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
    await expect(links).toHaveCount(Math.ceil(first.length / fixture.columns) + Math.ceil(last.length / fixture.columns));
    // every captured and native-wrapped row has the complete destination
    for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
    await expect(page.getByRole('link', { name: /^Preview /u })).toHaveCount(0);
    // both the first and continuation rows must navigate to the same target
    for (const link of [links.first(), links.last()]) {
      const popupPromise = page.waitForEvent('popup');
      await link.click();
      const popup = await popupPromise;
      await expect(popup).toHaveURL(uri);
      await popup.close();
    }
  });
}

// a complete identifier must not absorb neighboring prose or another path
for (const next of ['Next topic', 'src/plate_maps.ts', 'abad44dc-6180-4d3a-aac3-641b3af3a5c9/entity/protocol']) {
  // keep each hard-break counterexample independent
  test(`does not extend a complete UUID URL with ${next}`, async ({ page }) => {
    const uri = 'https://example.com/trial/e70d6fd5-8ede-486a-9642-448ef47e6401';
    await mountCapturedLink(page, `  ${uri}\r\n  ${next}`, 160);

    const links = page.getByRole('link', { name: /^Open /u });
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('href', uri);
  });
}

// native wraps must not relax the older directory-continuation guard
test('keeps a file mention separate after a native-wrapped directory URL', async ({ page }) => {
  const uri = 'https://example.com/very/long/assets/';
  await mountCapturedLink(page, `  ${uri}\r\n  src/plate_maps.ts`, 30);

  const links = page.getByRole('link', { name: /^Open /u });
  await expect(links).toHaveCount(2);
  // both native rows retain the original URL
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
  await expect(page.getByRole('link', { name: 'Preview src/plate_maps.ts', exact: true })).toHaveCount(1);
});

// cover padding before the terminal edge
test('joins an indented captured URL before the physical terminal edge', async ({ page }) => {
  const uri = 'https://example.com/instance-icons/heart.svg';
  const firstFragment = 'https://example.com/instance-icons/';
  const lastFragment = 'heart.svg';
  await mountCapturedLink(page, `  ${firstFragment}\r\n  ${lastFragment}`);

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri);
  await expect(links.last()).toHaveAttribute('href', uri);
  const firstCells = await overlayCells(page, links.first());
  const lastCells = await overlayCells(page, links.last());
  expect(firstCells.column).toBeCloseTo(2, 1);
  expect(firstCells.columns).toBeCloseTo(firstFragment.length, 1);
  expect(lastCells.column).toBeCloseTo(2, 1);
  expect(lastCells.columns).toBeCloseTo(lastFragment.length, 1);
  await expect(page.getByRole('link', { name: 'Preview heart.svg', exact: true })).toHaveCount(0);
});

// cover delimiters and complex prefix cells
test('reconstructs an indented parenthesized URL split inside its scheme', async ({ page }) => {
  const uri = 'https://example.com/instance-icons/heart.svg';
  const firstFragment = 'https:/';
  const lastFragment = '/example.com/instance-icons/heart.svg';
  await mountCapturedLink(page, `  📎界 é [View icon](${firstFragment}\r\n  ${lastFragment})`);

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri);
  await expect(links.last()).toHaveAttribute('href', uri);
  const firstCells = await overlayCells(page, links.first());
  const lastCells = await overlayCells(page, links.last());
  expect(firstCells.column).toBeCloseTo(20, 1);
  expect(firstCells.columns).toBeCloseTo(firstFragment.length, 1);
  expect(lastCells.column).toBeCloseTo(2, 1);
  expect(lastCells.columns).toBeCloseTo(lastFragment.length, 1);
});

// cover every physical continuation segment
test('opens the full target from every row of a three-row padded capture', async ({ page }) => {
  const uri = 'https://example.com/releases/2026/10/09/builds/12345/details?view=summary';
  // serve one controlled destination
  await page.route('https://example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<main>controlled link target</main>' }));
  await mountCapturedLink(page, '  https://example.com/releases/2026/\r\n  10/09/builds/12345/details?view=\r\n  summary');

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(3);
  const expectedWidths = ['https://example.com/releases/2026/'.length, '10/09/builds/12345/details?view='.length, 'summary'.length];
  // verify each visible segment independently
  for (const [index, width] of expectedWidths.entries()) {
    const link = links.nth(index);
    await expect(link).toHaveAttribute('href', uri);
    const cells = await overlayCells(page, link);
    expect(cells.column).toBeCloseTo(2, 1);
    expect(cells.columns).toBeCloseTo(width, 1);
    const popupPromise = page.waitForEvent('popup');
    await link.click();
    const popup = await popupPromise;
    await expect(popup).toHaveURL(uri);
    await popup.close();
  }
});

// reject ordinary prose continuation
test('does not append indented prose or file mentions after a complete link', async ({ page }) => {
  const uri = 'https://example.com/docs';
  await mountCapturedLink(page, '  https://example.com/docs\r\n  README.md is the next topic');

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
  await expect(page.getByRole('link', { name: /Open https:\/\/example\.com\/docsREADME/u })).toHaveCount(0);
});

// reject continuation after a closing delimiter
test('does not append an indented file mention after a closed markdown link', async ({ page }) => {
  const uri = 'https://example.com/docs';
  await mountCapturedLink(page, '  [Docs](https://example.com/docs)\r\n  README.md is separate');

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
});

// reject standalone documentation files
test('does not append a standalone README after a slash-ending directory URL', async ({ page }) => {
  const uri = 'https://example.com/assets/';
  await mountCapturedLink(page, `  ${uri}\r\n  README.md`);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
  await expect(page.getByRole('link', { name: 'Preview README.md', exact: true })).toHaveCount(1);
});

// reject a neighboring url
test('keeps adjacent indented URLs separate', async ({ page }) => {
  const firstUri = 'https://example.com/one/';
  const secondUri = 'https://example.com/two';
  await mountCapturedLink(page, `  ${firstUri}\r\n  ${secondUri}`);

  await expect(page.getByRole('link', { name: `Open ${firstUri}`, exact: true })).toHaveCount(1);
  await expect(page.getByRole('link', { name: `Open ${secondUri}`, exact: true })).toHaveCount(1);
});

// reject unindented near-edge prose
test('does not join unindented near-edge prose after a URL', async ({ page }) => {
  const uri = 'https://example.com/a';
  await mountCapturedLink(page, `Visit ${uri}\r\nNext topic`, 31);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
});

// reject matching-indent near-edge prose
test('does not join indented near-edge prose after a URL', async ({ page }) => {
  const uri = 'https://example.com/a';
  await mountCapturedLink(page, `  See ${uri}\r\n  Next topic`, 31);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
});

// reject indented prose after an exact edge
test('does not join indented prose after an exact-edge URL', async ({ page }) => {
  const uri = 'https://example.com/pathx';
  await mountCapturedLink(page, `Visit ${uri}\r\n  Next topic`, 31);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
});

// reject unfinished unindented parentheses
test('does not join prose after an unfinished parenthesized URL', async ({ page }) => {
  const uri = 'https://example.com/docs';
  await mountCapturedLink(page, `(${uri}\r\nNext topic`);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
});

// reject unfinished indented parentheses
test('does not join indented prose after an unfinished parenthesized URL', async ({ page }) => {
  const uri = 'https://example.com/docs';
  await mountCapturedLink(page, `  (${uri}\r\n  Next topic`);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
});

// reject unfinished unindented markdown
test('does not join prose after an unfinished markdown URL', async ({ page }) => {
  const uri = 'https://example.com/docs';
  await mountCapturedLink(page, `[Docs](${uri}\r\nNext topic`);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
});

// reject unfinished indented markdown
test('does not join indented prose after an unfinished markdown URL', async ({ page }) => {
  const uri = 'https://example.com/docs';
  await mountCapturedLink(page, `  [Docs](${uri}\r\n  Next topic`);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
});

// accept a closed three-row markdown target
test('joins a three-row padded markdown URL only through its closing delimiter', async ({ page }) => {
  const uri = 'https://example.com/abcdefghijklmno';
  await mountCapturedLink(page, '  [Docs](https://example.com/abcde\r\n  fghij\r\n  klmno)');

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(3);
  // verify every closed markdown segment
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
});

// retain URL punctuation that becomes interior after joining captured rows
for (const separator of ['?', ':', ',', '.']) {
  // verify every separator against terminal output rather than a string-only helper
  test(`joins captured URL rows ending in ${separator}`, async ({ page }) => {
    const uri = `https://example.com/path${separator}item=12345&view=all`;
    await page.goto('/');
    await page.setContent('<div id="output-links"></div>');
    await page.evaluate(async uri => {
      const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
      await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri.slice(0, 25)}\r\n${uri.slice(25)} for details.`, 31);
    }, uri);
    const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
    await expect(links).toHaveCount(2);
    await expect(links.first()).toHaveAttribute('href', uri);
    await expect(links.last()).toHaveAttribute('href', uri);
  });
}

// do not turn sentence punctuation and a real newline into a fabricated URL
for (const separator of ['?', ':', ',', '.']) {
  // keep a hard-break counterexample for each newly accepted punctuation boundary
  test(`does not append prose after a captured URL ending in ${separator}`, async ({ page }) => {
    const uri = 'https://example.com/path';
    await page.goto('/');
    await page.setContent('<div id="output-links"></div>');
    await page.evaluate(async ({ uri, separator }) => {
      const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
      await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri}${separator}\r\nNext line`, 31);
    }, { uri, separator });
    const links = page.getByRole('link');
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute('href', uri);
  });
}

// retain numeric URL continuations such as an explicit port
test('joins a captured URL split before a numeric port', async ({ page }) => {
  const uri = 'https://example.com:8443';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `${' '.repeat(11)}${uri.slice(0, 20)}\r\n${uri.slice(20)}`, 31);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri);
  await expect(links.last()).toHaveAttribute('href', uri);
});

// carry a complete destination through every captured continuation row
test('joins three captured URL rows into one destination', async ({ page }) => {
  const uri = 'https://example.com/path?item=12345&filter=complete&sort=updated&view=details';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri.slice(0, 25)}\r\n${uri.slice(25, 56)}\r\n${uri.slice(56)} for details.`, 31);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(3);
  // every visible row must open the same full destination
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
  const popupPromise = page.waitForEvent('popup');
  await links.last().click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(uri);
  await popup.close();
});

// reconstruct a scheme that was captured before both slashes were printed
test('joins captured rows split inside the URL scheme', async ({ page }) => {
  const uri = 'https://example.com/path?item=12';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `${' '.repeat(24)}${uri.slice(0, 6)}\r\n${uri.slice(6)}`);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveAttribute('href', uri);
  await expect(links.last()).toHaveAttribute('href', uri);
});

// retain native soft-wrap behavior alongside captured-row reconstruction
test('keeps the full destination across native xterm soft wraps', async ({ page }) => {
  const uri = 'https://example.com/path?item=12345&filter=complete&sort=updated&view=details';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri} for details.`, 31);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(3);
  // every soft-wrapped segment must retain the entire query string
  for (const link of await links.all()) await expect(link).toHaveAttribute('href', uri);
});

// preserve real whitespace at a soft-wrap boundary instead of extending the URL
test('does not append the next wrapped word after a URL delimiter', async ({ page }) => {
  const uri = 'https://example.com/path';
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async uri => {
    const { renderOutputLinkText } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinkText(document.querySelector<HTMLElement>('#output-links')!, `Visit ${uri} next word`, 31);
  }, uri);
  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute('href', uri);
});

// preserve every native delimiter space
test('preserves boundary spaces before the next native-wrapped word', async ({ page }) => {
  const uri = 'https://example.com/path';
  await mountCapturedLink(page, `See: ${uri}  next word`, 31);

  const links = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute('href', uri);
});

// cover native complex-cell geometry
test('maps a native link after emoji and combining text to exact cells', async ({ page }) => {
  const uri = 'https://example.com/path';
  await mountCapturedLink(page, `📎界 é ${uri}`, 31);

  const link = page.getByRole('link', { name: `Open ${uri}`, exact: true });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', uri);
  const cells = await overlayCells(page, link, 31);
  expect(cells.column).toBeCloseTo(6, 1);
  expect(cells.columns).toBeCloseTo(uri.length, 1);
});

test('keeps native output links stable, clickable, and available to the context menu', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="output-links"></div>');
  await page.evaluate(async () => {
    const { renderOutputLinks } = await import('/e2e/output-links-fixture.ts');
    await renderOutputLinks(document.querySelector<HTMLElement>('#output-links')!);
  });
  await expect(page.locator('#output-links')).toHaveAttribute('data-ready', 'true');
  const link = page.locator('.output-link-overlay');
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', 'https://example.com/output');
  await expect(link).toHaveCSS('cursor', 'pointer');
  await page.evaluate(() => {
    document.body.dataset.linkMutations = '0';
    new MutationObserver(records => {
      const changes = records.flatMap(record => [...record.addedNodes, ...record.removedNodes]).filter(node => node instanceof Element && (node.matches('.output-link-overlay') || node.querySelector('.output-link-overlay'))).length;
      document.body.dataset.linkMutations = String(Number(document.body.dataset.linkMutations ?? '0') + changes);
    }).observe(document.querySelector('#output-links')!, { childList: true, subtree: true });
  });
  const bounds = await link.boundingBox();
  expect(bounds).not.toBeNull();
  await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
  await page.evaluate(async () => {
    const { startOutputLinkRefresh } = await import('/e2e/output-links-fixture.ts');
    startOutputLinkRefresh();
  });
  await page.waitForTimeout(100);
  const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
  await expect.poll(async () => await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.classList.contains('output-link-overlay') ?? false, point)).toBe(true);
  const popupPromise = page.waitForEvent('popup');
  await page.mouse.click(point.x, point.y);
  const popup = await popupPromise;
  await popup.close();
  await expect(page.locator('body')).toHaveAttribute('data-opened', 'true');
  await page.waitForTimeout(250);
  await expect(page.locator('body')).toHaveAttribute('data-link-mutations', '0');
  await page.evaluate(() => {
    document.addEventListener('contextmenu', event => {
      const link = (event.target as Element).closest('a');
      document.body.dataset.contextLink = link?.getAttribute('href') ?? '';
    }, { once: true });
  });
  let rightClickOpened = false;
  page.once('popup', popup => { rightClickOpened = true; void popup.close(); });
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.waitForTimeout(100);
  expect(rightClickOpened).toBe(false);
  await expect(page.locator('body')).toHaveAttribute('data-context-link', 'https://example.com/output');
  await page.evaluate(async () => {
    const { stopOutputLinkRefresh } = await import('/e2e/output-links-fixture.ts');
    stopOutputLinkRefresh();
  });
});
