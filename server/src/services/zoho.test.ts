import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import { ZohoService, externalAttendees } from './zoho';

interface Received { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

// Local stand-in for accounts.zoho.eu + zohoapis.eu
async function withFakeZoho(
  records: { leads?: object[]; contacts?: object[] },
  run: (service: ZohoService, received: Received[]) => Promise<void>
): Promise<void> {
  const received: Received[] = [];
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      received.push({ method: req.method ?? '', url, headers: req.headers, body: Buffer.concat(parts).toString('latin1') });
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const noContent = () => { res.writeHead(204); res.end(); };

      if (url.startsWith('/oauth/v2/token')) return json(200, { access_token: 'tok', expires_in: 3600 });
      if (url.startsWith('/Leads/search')) return records.leads?.length ? json(200, { data: records.leads }) : noContent();
      if (url.startsWith('/Contacts/search')) return records.contacts?.length ? json(200, { data: records.contacts }) : noContent();
      if (url.includes('/Attachments')) return json(200, { data: [{ code: 'SUCCESS', details: { id: 'att1' } }] });
      return json(404, { error: 'unexpected ' + url });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    await run(new ZohoService({ accountsUrl: base, apiUrl: base, clientId: 'id', clientSecret: 'secret', refreshToken: 'r' }), received);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('finds a Lead by email', async () => {
  await withFakeZoho({ leads: [{ id: 'L1', Full_Name: 'Nino Beridze', Email: 'nino@acme.com' }] }, async (zoho, received) => {
    const found = await zoho.findByEmail('nino@acme.com');

    assert.deepEqual(found, [{ module: 'Leads', id: 'L1', name: 'Nino Beridze' }]);
    assert.ok(received.some(r => r.url === '/Leads/search?email=nino%40acme.com'));
  });
});

test('finds the same person as a Lead and as a Contact', async () => {
  const both = {
    leads: [{ id: 'L1', Full_Name: 'Nino Beridze', Email: 'nino@acme.com' }],
    contacts: [{ id: 'C1', Full_Name: 'Nino B', Email: 'nino@acme.com' }],
  };

  await withFakeZoho(both, async (zoho) => {
    assert.deepEqual(await zoho.findByEmail('nino@acme.com'), [
      { module: 'Leads', id: 'L1', name: 'Nino Beridze' },
      { module: 'Contacts', id: 'C1', name: 'Nino B' },
    ]);
  });
});

test('returns nothing when nobody in the CRM has that email', async () => {
  await withFakeZoho({}, async (zoho) => {
    assert.deepEqual(await zoho.findByEmail('nobody@acme.com'), []);
  });
});

test('uploads a file as an attachment of the record', async () => {
  await withFakeZoho({}, async (zoho, received) => {
    await zoho.uploadAttachment('Leads', 'L1', 'Call.docx', Buffer.from('docx-bytes'));

    const upload = received.find(r => r.url === '/Leads/L1/Attachments')!;
    assert.equal(upload.method, 'POST');
    assert.equal(upload.headers.authorization, 'Zoho-oauthtoken tok');
    assert.match(upload.headers['content-type'] ?? '', /multipart\/form-data/);
    assert.match(upload.body, /name="file"; filename="Call\.docx"/);
    assert.match(upload.body, /docx-bytes/);
  });
});

test('only people outside the company get the transcript attached', () => {
  const attendees = [
    { name: 'Gigi', email: 'gigig@gegidze.com' },
    { name: 'Keti', email: 'Keti@Gegidze.com' },
    { name: 'Nino', email: 'nino@acme.com' },
  ];

  assert.deepEqual(externalAttendees(attendees, 'gigig@gegidze.com').map(a => a.email), ['nino@acme.com']);
});

test('keeps everyone when the organiser has no company domain', () => {
  const attendees = [{ name: 'Nino', email: 'nino@acme.com' }];

  assert.deepEqual(externalAttendees(attendees, ''), attendees);
});
